// @ts-nocheck

import { DescriptionType } from '#models/photo'
import Tag from '#models/tag'
import TagPhoto from '#models/tag_photo'
import ModelsService from '#services/models_service'
import PhotoManager from '../../managers/photo_manager.js'
import TagManager from '../../managers/tag_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { STOPWORDS } from '../../utils/StopWords.js'
import { AnalyzerTask } from './analyzerTask.js'
import NLPService from '../../services/nlp_service.js'

export class TagTask extends AnalyzerTask {
  declare prompt: string | Function
  declare descriptionSourceFields: DescriptionType[]
  declare data: Record<string, { name: string; group: string }[]>
  private nlpService: NLPService
  private tagToSustantivesMap: Map<string, string[]>
  private embeddingsMap: Map<string, number[]>

  constructor() {
    super()
    this.nlpService = new NLPService()
    this.tagToSustantivesMap = new Map()
    this.embeddingsMap = new Map()
  }

  public async commit() {
    const batchEmbeddingsSize = 200 // tamaño inicial del lote

    const modelsService = new ModelsService()
    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')

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

    // 3. Verificar qué términos ya tienen embeddings en la base de datos
    const termsArray = Array.from(allTerms)
    const existingTags = await Tag.query()
      .whereIn('name', termsArray)
      .whereNotNull('embedding')
      .select('name', 'embedding')

    // 4. Cargar embeddings existentes en el mapa
    for (const tag of existingTags) {
      const embedding = tag.getParsedEmbedding()
      if (embedding) {
        this.embeddingsMap.set(tag.name, embedding)
      }
    }

    // 5. Obtener embeddings solo para los términos que no los tienen
    const termsWithoutEmbeddings = termsArray.filter((term) => !this.embeddingsMap.has(term))
    for (let i = 0; i < termsWithoutEmbeddings.length; i += batchEmbeddingsSize) {
      const batch = termsWithoutEmbeddings.slice(i, i + batchEmbeddingsSize)
      const { embeddings } = await modelsService.getEmbeddings(batch)
      batch.forEach((name, idx) => {
        this.embeddingsMap.set(name, embeddings[idx])
      })
    }

    for (const photoId of Object.keys(this.data)) {
      const tagPhotosList: TagPhoto[] = []
      for (const tagData of this.data[photoId]) {
        const lower = tagData.name.toLocaleLowerCase()
        if (STOPWORDS.includes(lower)) continue

        // 6. Usar el embedding precomputado del mapa
        const emb = this.embeddingsMap.get(tagData.name)
        const existingOrCreatedTag: Tag = await tagManager.getOrCreateSimilarTag(tagData, emb)

        const tagPhoto = new TagPhoto()
        tagPhoto.tagId = existingOrCreatedTag.id
        tagPhoto.photoId = Number(photoId)
        tagPhoto.category = category
        if (
          tagPhotosList.some(
            (tp) => tp.tagId === tagPhoto.tagId && tp.category === tagPhoto.category
          )
        ) {
          console.log(`[AnalyzerProcess] TagTask: skipping duplicate tagPhoto: ${tagPhoto.tagId}`)
          continue
        }
        tagPhotosList.push(tagPhoto)
      }

      await tagPhotoManager.deleteByPhotoAndCategory(photoId, category)
      await photoManager.updateTagsPhoto(
        photoId,
        tagPhotosList,
        this.tagToSustantivesMap,
        this.embeddingsMap
      )
    }
  }
}
