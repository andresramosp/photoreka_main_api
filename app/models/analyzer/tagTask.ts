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

export class TagTask extends AnalyzerTask {
  declare prompt: string | Function
  declare descriptionSourceFields: DescriptionType[]
  declare data: Record<string, { name: string; group: string }[]>

  public async commit() {
    const modelsService = new ModelsService()
    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')

    // 1. Agregar todos los nombres de tags únicos
    const allTagNames = Array.from(
      new Set(
        Object.values(this.data)
          .flat()
          .map((t) => t.name)
      )
    )

    // 2. Obtener embeddings en bloque
    const { embeddings } = await modelsService.getEmbeddings(allTagNames)
    // embeddings: Array de vectores matching allTagNames
    const embeddingsMap = allTagNames.reduce(
      (map, name, i) => {
        map[name] = embeddings[i]
        return map
      },
      /** @type Record<string, number[]> */ {}
    )

    for (const photoId of Object.keys(this.data)) {
      const tagPhotosList: TagPhoto[] = []
      for (const tagData of this.data[photoId]) {
        const lower = tagData.name.toLocaleLowerCase()
        if (STOPWORDS.includes(lower)) continue

        // 3. Pasar solo el embedding precomputado
        const emb = embeddingsMap[tagData.name]
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
      await photoManager.updateTagsPhoto(photoId, tagPhotosList)
    }
  }
}
