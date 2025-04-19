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

  private readonly photoBatchSize = 10
  private readonly tagBatchSize = 25

  public async commit(): Promise<void> {
    const tagPhotoManager = new TagPhotoManager()
    const photoManager = new PhotoManager()
    const tagManager = new TagManager()
    const category = this.descriptionSourceFields.join('_')

    const photoIds = Object.keys(this.data)

    // Process photos in bounded parallel batches
    for (let i = 0; i < photoIds.length; i += this.photoBatchSize) {
      const photoBatch = photoIds.slice(i, i + this.photoBatchSize)

      await Promise.all(
        photoBatch.map(async (photoId) => {
          const tagPhotosList: TagPhoto[] = []
          const tagDataArray = this.data[photoId] || []

          // Inner batching for tag operations to keep connection pool healthy
          for (let j = 0; j < tagDataArray.length; j += this.tagBatchSize) {
            const tagBatch = tagDataArray.slice(j, j + this.tagBatchSize)

            await Promise.all(
              tagBatch
                .filter((tagData) => !STOPWORDS.includes(tagData.name.toLocaleLowerCase()))
                .map(async (tagData) => {
                  const existingOrCreated: Tag = await tagManager.getOrCreateSimilarTag(tagData)

                  const tagPhoto = new TagPhoto()
                  tagPhoto.tagId = existingOrCreated.id
                  tagPhoto.photoId = Number(photoId)
                  tagPhoto.category = category

                  // De‑dupe in‑memory before persisting
                  if (
                    !tagPhotosList.some(
                      (tp) => tp.tagId === tagPhoto.tagId && tp.category === tagPhoto.category
                    )
                  ) {
                    tagPhotosList.push(tagPhoto)
                  } else {
                    console.log(
                      `[AnalyzerProcess] TagTask: skipping duplicate tagPhoto: ${tagPhoto.tagId}`
                    )
                  }
                })
            )
          }

          // Replace existing tag‑photo relations atomically for this category
          await tagPhotoManager.deleteByPhotoAndCategory(photoId, category)
          await photoManager.updateTagsPhoto(photoId, tagPhotosList)
        })
      )
    }
  }
}
