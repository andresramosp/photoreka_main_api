import Photo, { DescriptionType, PhotoDescriptions } from '#models/photo'
import TagPhoto from '#models/tag_photo'
import PhotoManager from '../../managers/photo_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'

export class VisionTask extends AnalyzerTask {
  declare prompts: string[] | Function[]
  declare resolution: 'low' | 'high'
  declare targetFieldType: 'descriptions' | 'tag_area' //
  declare sequential: boolean
  declare imagesPerBatch: number
  declare useGuideLines: boolean
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[] // de momento queda solo para Molmo, por su tipo de input
  declare data: Record<string, Record<string, string>> // foto -> { description_field -> text }
  declare complete: boolean // TODO: que serialize a BD, y usar para saber si la task ya se completó, en vez de mirar los fields

  public async commit() {
    try {
      const photoManager = new PhotoManager()
      const tagPhotoManager = new TagPhotoManager()
      if (this.targetFieldType == 'tag_area') {
        await Promise.all(
          Object.entries(this.data)
            .map(([photoId, tagPhotos]) => {
              if (!isNaN(photoId)) {
                const targetField = this.targetFieldType.split('_')[1]
                const tagPhotosToUpdate: { id: number; [targetField]: string }[] = Object.entries(
                  tagPhotos
                ).map(([id, value]) => ({
                  id: Number(id),
                  [targetField]: value,
                }))

                // Se podría re-chequear que los id's pertenecen a la foto (usando photoId)
                console.log(`update de tagPhotos: ${JSON.stringify(tagPhotosToUpdate)}`)

                return tagPhotosToUpdate.map((tagPhotoDelta) =>
                  tagPhotoManager.updateTagPhoto(tagPhotoDelta.id, {
                    [targetField]: tagPhotoDelta[targetField],
                  })
                )
              }
              return []
            })
            .flat()
        )
      } else {
        await Promise.all(
          Object.entries(this.data).map(([photoId, descriptions]) => {
            if (!isNaN(photoId)) {
              return photoManager.updatePhotoDescriptions(
                photoId,
                descriptions as PhotoDescriptions
              )
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
