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
    // Filtra aquí solo las fotos válidas
    const validPhotos: Photo[] = []
    const skippedPhotoIds: string[] = []

    for (const photo of photosWithTags) {
      // Validación especial para visual_aspects
      if (this.descriptionSourceFields.includes('visual_aspects')) {
        const visualAspectsData = photo.descriptions?.visual_aspects
        if (!visualAspectsData) {
          skippedPhotoIds.push(photo.id)
          continue
        }

        validPhotos.push(photo)
      } else {
        // Validación original para otros tipos de descripción
        const missing = this.descriptionSourceFields.some(
          (field) => !photo.descriptions || !photo.descriptions[field]
        )
        if (missing) {
          skippedPhotoIds.push(photo.id)
        } else {
          validPhotos.push(photo)
        }
      }
    }

    if (skippedPhotoIds.length > 0) {
      logger.info(
        `Saltando ${skippedPhotoIds.length} fotos por no tener descripciones requeridas: ${skippedPhotoIds.join(', ')}`
      )
    }

    if (validPhotos.length === 0) {
      logger.warn('No hay fotos válidas para procesar.')
      return
    }

    // Detectar si estamos procesando visual_aspects
    const isVisualAspects = this.descriptionSourceFields.includes('visual_aspects')

    if (isVisualAspects) {
      logger.debug('Procesando extracción de tags de visual_aspects...')
      await this.extractTagsFromVisualAspects(validPhotos)
    } else {
      const cleanedResults = await this.cleanPhotosDescs(validPhotos)
      logger.debug('Procesando extracción de tags...')
      await this.requestTagsFromGPT(validPhotos, cleanedResults)
    }
    logger.debug('Procesando creación de tags...')
  }

  async commit(): Promise<void> {
    const batchEmbeddingsSize = 150
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
    const isVisualAspects = category === 'visual_aspects'

    // Solo calcular sustantivos si no es visual_aspects
    if (!isVisualAspects) {
      for (const tagName of allTagNames) {
        const sustantives = this.nlpService.getSustantives(tagName) ?? []
        this.tagToSustantivesMap.set(tagName, sustantives)
        sustantives.forEach((s) => allTerms.add(s))
      }
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

    // 5. Obtener embeddings solo para los que no los tienen aún con concurrencia
    const termsWithoutEmbeddings = termsArray.filter((term) => !this.embeddingsMap.has(term))
    if (termsWithoutEmbeddings.length > 0) {
      const embeddingsConcurrency = 3 // concurrencia para embeddings
      const embeddingsDelay = 1000 // 1 segundo de demora entre batches de embeddings
      const embeddingsLimit = pLimit(embeddingsConcurrency)
      const embeddingTasks: Promise<void>[] = []

      for (let i = 0; i < termsWithoutEmbeddings.length; i += batchEmbeddingsSize) {
        const batch = termsWithoutEmbeddings.slice(i, i + batchEmbeddingsSize)
        const taskIndex = Math.floor(i / batchEmbeddingsSize)

        const embeddingTask = embeddingsLimit(async () => {
          if (taskIndex > 0) {
            await new Promise((resolve) => setTimeout(resolve, embeddingsDelay))
          }
          logger.debug(
            `Obteniendo embeddings para batch de ${batch.length} tags (${i + 1}-${i + batch.length} de ${termsWithoutEmbeddings.length})`
          )
          const { embeddings } = await this.modelsService.getEmbeddingsCPU(batch)

          // Asignar embeddings a los términos
          batch.forEach((name, idx) => {
            this.embeddingsMap.set(name, embeddings[idx])
          })
        })
        embeddingTasks.push(embeddingTask)
      }

      await Promise.all(embeddingTasks)
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

        results.push(...sourceTexts)

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
    const totalPhotos = photos.length
    const concurrencyLimit = 10

    logger.debug(
      `Llamadas individuales a GPT para ${photos.length} imágenes (máximo ${concurrencyLimit} en paralelo)`
    )

    const limit = pLimit(concurrencyLimit)

    const tagRequests = photos.map((photo, index) =>
      limit(async () => {
        try {
          const { result: extractedTagsResponse } = await this.modelsService.getGPTResponse(
            this.prompt as string,
            JSON.stringify({ description: cleanedResults[index] }),
            'gpt-4o-mini'
          )
          const { tags: tagList } = extractedTagsResponse

          this.data[photo.id] = []

          tagList.forEach((tagStr: string) => {
            const [tag, group = 'misc'] = tagStr.split('|').map((i) => i.trim())
            const newTag = new Tag()
            newTag.name = tag
            newTag.group = group
            this.data[photo.id].push(newTag)
          })

          const progress = Math.floor(((index + 1) / totalPhotos) * 100)
          logger.debug(`Procesada imagen ${photo.id} (${progress}%)`)
        } catch (err) {
          logger.error(`Error procesando foto ${photo.id}: ${err}`)
          // No hacer throw - continuar con las demás fotos
        }
      })
    )

    await Promise.all(tagRequests)
  }

  private async extractTagsFromVisualAspects(photos: Photo[]) {
    logger.debug(`Extrayendo tags de visual_aspects para ${photos.length} imágenes`)

    // Keys que usan la regla value + key
    const keyWithSuffix = ['orientation', 'focus', 'lighting', 'framing', 'genre']

    for (const photo of photos) {
      try {
        this.data[photo.id] = []
        const visualAspectsData = photo.descriptions?.visual_aspects
        if (!visualAspectsData) {
          logger.warn(`Foto ${photo.id} no tiene datos de visual_aspects`)
          continue
        }

        // visual_aspects ya viene como objeto JSON
        const aspectsObject = visualAspectsData as Record<string, string[]>

        // Extraer tags de cada aspecto visual
        for (const [aspectKey, aspectValues] of Object.entries(aspectsObject)) {
          if (Array.isArray(aspectValues)) {
            for (const value of aspectValues) {
              if (value && typeof value === 'string') {
                let tagName = ''
                if (keyWithSuffix.includes(aspectKey)) {
                  tagName = `${value.trim()} ${aspectKey}`
                } else {
                  tagName = `${value.trim()} photography`
                }
                const newTag = new Tag()
                newTag.name = tagName
                newTag.group = 'visual_aspects'
                this.data[photo.id].push(newTag)
              }
            }
          }
        }

        logger.debug(`Extraídos ${this.data[photo.id].length} tags para foto ${photo.id}`)
      } catch (error) {
        logger.error(`Error procesando visual_aspects para foto ${photo.id}:`, error)
        // Continuar con las demás fotos
      }
    }
  }

  private getSourceTextFromPhoto(photo: Photo) {
    let text = ''

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
