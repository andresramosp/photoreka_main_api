import { DescriptionType } from '#models/photo'
import Tag from '#models/tag'
import TagPhoto from '#models/tag_photo'
import PhotoManager from '../../managers/photo_manager.js'
import TagManager from '../../managers/tag_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { STOPWORDS } from '../../utils/StopWords.js'
import { AnalyzerTask } from './analyzerTask.js'

export class TagTask extends AnalyzerTask {
  declare prompt: string | Function
  declare descriptionSourceFields: DescriptionType[]
  declare data: Record<string, Tag[]> // foto -> { name, group...}

  public async commit() {
    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')

    for (const photoId of Object.keys(this.data)) {
      const tagPhotosList: TagPhoto[] = []
      for (const tagData of this.data[photoId]) {
        if (STOPWORDS.includes(tagData.name.toLocaleLowerCase())) {
          continue
        }
        const existingOrCreatedTag: Tag = await tagManager.getOrCreateSimilarTag(tagData)
        const tagPhoto = new TagPhoto()
        tagPhoto.tagId = existingOrCreatedTag.id
        tagPhoto.photoId = Number(photoId)
        tagPhoto.category = category
        if (
          tagPhotosList.find(
            (tp: TagPhoto) => tp.tagId == tagPhoto.tagId && tp.category == tagPhoto.category
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
