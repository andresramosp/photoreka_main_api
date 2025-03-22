import { DescriptionType, PhotoDescriptions } from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'

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
              return photoManager.updatePhotoDescriptions(id, descriptions as PhotoDescriptions)
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
