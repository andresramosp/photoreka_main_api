import type { HttpContext } from '@adonisjs/core/http'
import Tag from '#models/tag'
import Photo from '#models/photo'

export default class TagsController {
  public async syncTagsWithPhotos() {
    // Step 1: Retrieve all photos with metadata
    const photos = await Photo.all()

    for (const photo of photos) {
      // Parse the metadata column to extract tags
      const metadata = photo.metadata
      if (metadata && metadata.tags) {
        const tags = metadata.tags

        // Step 2: Ensure tags exist in the `tags` table
        const tagInstances = []
        for (const tagName of tags) {
          const existingTag = await Tag.findBy('name', tagName)
          if (existingTag) {
            tagInstances.push(existingTag)
          } else {
            const newTag = await Tag.create({ name: tagName })
            tagInstances.push(newTag)
          }
        }

        // Step 3: Create the many-to-many relationship
        if (tagInstances.length > 0) {
          await photo.related('tags').sync(
            tagInstances.map((tag) => tag.id),
            false
          )
        }
      }
    }
  }

  public async list({ request, response }: HttpContext) {
    // Step 4: Sync tags before listing
    //await this.syncTagsWithPhotos()

    // Fetch all tags to return as response
    const result = await Tag.all()
    return response.ok({ result })
  }
}
