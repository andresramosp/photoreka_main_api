import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Tag from '#models/tag'
import PhotoManager from '../../managers/photo_manager.js'
import { SplitMethods } from '../../analyzer_packages.js'
import { ModelType } from './analyzerProcess.js'
import TagPhoto from '#models/tag_photo'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import TagManager from '../../managers/tag_manager.js'
import { STOPWORDS } from '../../utils/StopWords.js'

export class AnalyzerTask {
  declare name: string
  declare model: ModelType

  toJSON() {
    return { name: this.name }
  }
}

export class VisionTask extends AnalyzerTask {
  declare prompts: string[] | Function[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare tagsTarget: string
  declare imagesPerBatch: number
  declare useGuideLines: boolean
  declare promptDependentField: DescriptionType
  declare promptsTarget: DescriptionType[]
  declare data: Record<string, Record<string, string>> // foto -> { description_field -> text }
  declare complete: boolean // TODO: que serialize a BD, y usar para saber si la task ya se completó, en vez de mirar los fields

  public async commit() {
    try {
      const photoManager = new PhotoManager()
      const tagPhotoManager = new TagPhotoManager()
      if (this.tagsTarget == 'area') {
        await Promise.all(
          Object.entries(this.data).map(([id, tags]) => {
            if (!isNaN(id)) {
              // TODO: invocar a tagPhotoManager.updateTagPhoto por cada entrada en tags, que es un objeto con ids -> area
              // OJO: el inject al message tendria que llevar el id del tagPhoto para facilitar el update
            }
            return Promise.resolve(null)
          })
        )
      } else {
        await Promise.all(
          Object.entries(this.data).map(([id, descriptions]) => {
            if (!isNaN(id)) {
              return photoManager.updatePhoto(id, {
                descriptions: descriptions as PhotoDescriptions,
              })
            }
            return Promise.resolve(null)
          })
        )
      }

      // this.data = {} // TODO: probar
    } catch (err) {
      console.log(`[AnalyzerProcess] Error guardando ${JSON.stringify(this.data)}`)
    }
  }
}

export class TagTask extends AnalyzerTask {
  declare prompt: string | Function
  declare descriptionSourceFields: DescriptionType[]
  declare data: Record<string, Tag[]> // foto -> { name, group...}

  public async commit() {
    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')
    const tagPhotosList: TagPhoto[] = []

    for (const photoId of Object.keys(this.data)) {
      for (const tagData of this.data[photoId]) {
        if (STOPWORDS.includes(tagData.name.toLocaleLowerCase())) {
          continue
        }
        const existingOrCreatedTag: Tag = await tagManager.getOrCreateSimilarTag(tagData)
        const tagPhoto = new TagPhoto()
        tagPhoto.tagId = existingOrCreatedTag.id
        tagPhoto.photoId = Number(photoId)
        tagPhoto.category = category
        tagPhotosList.push(tagPhoto)
      }

      await tagPhotoManager.deleteByPhotoAndCategory(photoId, category)
      await photoManager.addTagsPhoto(photoId, tagPhotosList)
    }
  }
}

export class ChunkTask extends AnalyzerTask {
  declare descriptionSourceFields: DescriptionType[]
  declare descriptionsChunksMethod: Record<DescriptionType, SplitMethods>
  declare data: Record<string, DescriptionChunk[]>

  public async commit() {
    // TODO
  }
}
