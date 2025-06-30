// @ts-nocheck

import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import Tag from '#models/tag'
import TagPhoto from '#models/tag_photo'
import ModelsService from '#services/models_service'
import PhotoManager from '../../managers/photo_manager.js'
import TagManager from '../../managers/tag_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { STOPWORDS } from '../../utils/StopWords.js'
import { AnalyzerTask } from './analyzerTask.js'
import NLPService from '../../services/nlp_service.js'
import AnalyzerProcess from './analyzerProcess.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import pLimit from 'p-limit'
import VectorService from '#services/vector_service'

const logger = Logger.getInstance('AnalyzerProcess', 'TagTask')
logger.setLevel(LogLevel.DEBUG)

export class TagTask extends AnalyzerTask {
  declare prompt: string | Function
  declare descriptionSourceFields: DescriptionType[]
  declare data: Record<string, { name: string; group: string }[]>

  private nlpService: NLPService
  private tagToSustantivesMap: Map<string, string[]>
  private embeddingsMap: Map<string, number[]>

  async process(pendingPhotos: Photo[]): Promise<void> {
    this.nlpService = new NLPService()
    this.tagToSustantivesMap = new Map()
    this.embeddingsMap = new Map()

    if (!this.data) {
      this.data = {}
    }

    const photoIds = pendingPhotos.map((photo) => photo.id)
    const photosWithTags = await Photo.query().whereIn('id', photoIds).preload('tags')

    logger.debug('Carga y limpieza de descripciones...')
    const cleanedResults = await this.cleanPhotosDescs(photosWithTags)
    logger.debug('Procesando extracción de tags...')

    await this.requestTagsFromGPT(photosWithTags, cleanedResults)
    logger.debug('Procesando creación de tags...')
  }

  async commit(): Promise<void> {
    const batchEmbeddingsSize = 200
    const concurrencyLimit = 25

    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')
    const limit = pLimit(concurrencyLimit)

    // 1. Agregar todos los nombres de tags únicos y recolectar sus sustantivos
    const allTagNames = Array.from(
      new Set(
        Object.values(this.data)
          .flat()
          .map((t) => t.name)
      )
    )

    // 2. Recolectar todos los sustantivos y preparar la lista de términos para embeddings
    const allTerms = new Set<string>(allTagNames)
    for (const tagName of allTagNames) {
      const sustantives = this.nlpService.getSustantives(tagName) ?? []
      this.tagToSustantivesMap.set(tagName, sustantives)
      sustantives.forEach((s) => allTerms.add(s))
    }

    // 3. Verificar qué términos ya tienen embeddings
    const termsArray = Array.from(allTerms)
    const existingTags = await Tag.query()
      .whereIn('name', termsArray)
      .whereNotNull('embedding')
      .select('name', 'embedding')

    for (const tag of existingTags) {
      const embedding = VectorService.getParsedEmbedding(tag.embedding)
      if (embedding) this.embeddingsMap.set(tag.name, embedding)
    }

    // 5. Obtener embeddings solo para los que no los tienen aún
    const termsWithoutEmbeddings = termsArray.filter((term) => !this.embeddingsMap.has(term))
    for (let i = 0; i < termsWithoutEmbeddings.length; i += batchEmbeddingsSize) {
      const batch = termsWithoutEmbeddings.slice(i, i + batchEmbeddingsSize)
      logger.debug(`Obteniendo embeddings para batch de ${batch.length} tags`)
      const { embeddings } = await this.modelsService.getEmbeddingsCPU(batch)
      batch.forEach((name, idx) => {
        this.embeddingsMap.set(name, embeddings[idx])
      })
    }

    // 6. Procesar las fotos con concurrencia limitada
    const processPhoto = async (photoId: string, tagDataList: TagPhotoInput[]) => {
      const tagPhotosList: TagPhoto[] = []

      for (const tagData of tagDataList) {
        const lower = tagData.name.toLocaleLowerCase()
        if (STOPWORDS.includes(lower)) continue

        const emb = this.embeddingsMap.get(tagData.name)
        const existingOrCreatedTag = await tagManager.getOrCreateSimilarTag(tagData, emb)

        const tagPhoto = new TagPhoto()
        tagPhoto.tagId = existingOrCreatedTag.id
        tagPhoto.photoId = Number(photoId)
        tagPhoto.category = category

        if (
          tagPhotosList.some(
            (tp) => tp.tagId === tagPhoto.tagId && tp.category === tagPhoto.category
          )
        ) {
          logger.info(`Saltando tagPhoto duplicado: ${tagPhoto.tagId}`)
          continue
        }

        tagPhotosList.push(tagPhoto)
      }

      await tagPhotoManager.deleteByPhotoAndCategory(photoId, category)
      await photoManager.updateTagsPhoto(
        photoId,
        tagPhotosList,
        this.tagToSustantivesMap,
        this.embeddingsMap,
        false
      )
    }

    const totalPhotos = Object.keys(this.data).length
    logger.info(`Guardando en BD ${totalPhotos} fotos (máximo ${concurrencyLimit} en paralelo)...`)
    await Promise.all(
      Object.entries(this.data).map(([photoId, tagDataList]) =>
        limit(() => processPhoto(photoId, tagDataList))
      )
    )

    const photoIds = Object.keys(this.data).map(Number)
    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)
    logger.debug(`Datos salvados para ${photoIds.length} imágenes`)
  }

  private async cleanPhotosDescs(photos: Photo[], batchSize = 5, delayMs = 500): Promise<string[]> {
    const results = []

    for (let i = 0; i < photos.length; i += batchSize) {
      const batch = photos.slice(i, i + batchSize)

      try {
        const sourceTexts = batch.map((photo) => {
          const text = this.getSourceTextFromPhoto(photo)
          return text
        })

        const cleanResult = await this.modelsService.cleanDescriptions(sourceTexts, 0.9, true)

        if (!cleanResult || !Array.isArray(cleanResult)) {
          logger.error(`Resultado inesperado de cleanDescriptions: ${JSON.stringify(cleanResult)}`)
          throw new Error('Resultado inválido de cleanDescriptions')
        }

        results.push(...cleanResult)

        if (i + batchSize < photos.length) {
          await this.sleep(delayMs)
        }
      } catch (error) {
        logger.error(`Error procesando lote ${i / batchSize + 1}:`, error)
        throw error
      }
    }

    return results
  }

  private async requestTagsFromGPT(photos: Photo[], cleanedResults: string[]) {
    const tagRequests: Promise<void>[] = []
    const totalPhotos = photos.length

    logger.debug(`Llamadas individuales a GPT para ${photos.length} imágenes`)

    photos.forEach((photo, index) => {
      const requestPromise = (async () => {
        await this.sleep(index * 500)

        try {
          const { result: extractedTagsResponse } = await this.modelsService.getGPTResponse(
            this.prompt as string,
            JSON.stringify({ description: cleanedResults[index] }),
            'gpt-4o-mini'
          )
          const { tags: tagList } = extractedTagsResponse

          // Asegurar "no people" si no hay grupo 'person'
          const hasPerson = tagList.some((t: string) => t.split('|')[1]?.trim() === 'person')
          if (!hasPerson) {
            tagList.push('no people | misc')
          }

          this.data[photo.id] = []

          tagList.forEach((tagStr: string) => {
            const [tag, group = 'misc'] = tagStr.split('|').map((i) => i.trim())
            const newTag = new Tag()
            newTag.name = tag
            newTag.group = group
            this.data[photo.id].push(newTag)
          })
        } catch (err) {
          logger.error(`Error en ${this.name} -> ${err}`)
          throw err
        }

        const progress = Math.floor(((index + 1) / totalPhotos) * 100)
        // process.stdout.write(`[${photo.id}] ${progress}% `)
      })()

      tagRequests.push(requestPromise)
    })

    await Promise.all(tagRequests)
    // process.stdout.write('\n')
  }

  private getSourceTextFromPhoto(photo: Photo) {
    let text = ''

    if (!photo || !photo.descriptions) {
      return ''
    }

    for (const category of this.descriptionSourceFields) {
      try {
        const description = photo.descriptions[category]

        let flattenedDescription: string

        if (description === null || description === undefined) {
          flattenedDescription = ''
        } else if (typeof description === 'object') {
          try {
            flattenedDescription = JSON.stringify(description)
          } catch (e) {
            logger.error(`Error al serializar descripción para la foto ${photo.id}:`, e)
            flattenedDescription = ''
          }
        } else {
          flattenedDescription = String(description)
        }

        text += `${category}: ${flattenedDescription} | `
      } catch (error) {
        logger.error(`Error procesando categoría ${category} para la foto ${photo.id}:`, error)
        continue
      }
    }

    return text.trim().replace(/\|$/, '')
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
