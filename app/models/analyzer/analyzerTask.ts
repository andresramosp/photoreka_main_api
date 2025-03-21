import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Tag from '#models/tag'
import PhotosService from '#services/photos_service'
import { SplitMethods } from '../../analyzer_packages.js'
import { ModelType } from './analyzerProcess.js'

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
      const photosService = new PhotosService()
      if (this.tagsTarget == 'area') {
        await Promise.all(
          Object.entries(this.data).map(([id, tags]) => {
            if (!isNaN(id)) {
              return photosService.updatePhoto(id, {
                tags: tags as any,
              })
            }
            return Promise.resolve(null)
          })
        )
      } else {
        await Promise.all(
          Object.entries(this.data).map(([id, descriptions]) => {
            if (!isNaN(id)) {
              return photosService.updatePhoto(id, {
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
  declare data: Record<string, Tag[]> // foto -> [tags]

  public async commit() {
    // TODO
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
