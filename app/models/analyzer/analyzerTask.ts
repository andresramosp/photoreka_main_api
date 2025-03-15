import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Tag from '#models/tag'
import PhotosService from '#services/photos_service'
import { ModelType } from './analyzerProcess.js'

export class AnalyzerTask {
  declare name: string
  declare model: ModelType
  declare overwrite: boolean // esto solo tiene sentido para determinar si se cogen fotos ya procesadas o no. Pero una tarea siempre hacer overwrite de sus descs/tags, no añade...

  toJSON() {
    return { name: this.name }
  }
}

export class VisionTask extends AnalyzerTask {
  declare prompts: string[] | Function[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare promptDependentField: DescriptionType
  declare promptsTarget: DescriptionType[]
  declare data: Record<string, Record<string, string>> // foto -> { description_field -> text }
  declare complete: boolean // TODO: que serialize a BD, y usar para saber si la task ya se completó, en vez de mirar los fields

  public async commit() {
    const photosService = new PhotosService()
    await Promise.all(
      Object.entries(this.data).map(([id, descriptions]) =>
        photosService.updatePhoto(id, { descriptions: descriptions as PhotoDescriptions })
      )
    )
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
  declare descriptionsChunksMethod: Record<DescriptionType, 'split_by_pipes' | 'split_by_size'>
  declare data: Record<string, DescriptionChunk[]>

  public async commit() {
    // TODO
  }
}
