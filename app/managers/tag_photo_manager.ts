import Tag from '#models/tag'
import TagPhoto from '#models/tag_photo'
import NLPService from '#services/nlp_service'
import TagManager from './tag_manager.js'

export default class TagPhotoManager {
  constructor() {}

  // Crea un nuevo TagPhoto
  public async createTagPhoto(data: Partial<TagPhoto>): Promise<TagPhoto> {
    const tagPhoto = await TagPhoto.create(data)
    return tagPhoto
  }

  // Obtiene un TagPhoto por su ID
  public async getTagPhotoById(id: string): Promise<TagPhoto> {
    const tagPhoto = await TagPhoto.find(id)
    if (!tagPhoto) throw new Error('TagPhoto not found')
    return tagPhoto
  }

  // Obtiene todos los TagPhotos (opcionalmente filtra por photoId)
  public async getAllTagPhotos(photoId?: string): Promise<TagPhoto[]> {
    const query = TagPhoto.query()
    if (photoId) query.where('photo_id', photoId)
    return await query
  }

  // Actualiza un TagPhoto existente
  public async updateTagPhoto(id: string, data: Partial<TagPhoto>): Promise<TagPhoto> {
    const tagPhoto = await TagPhoto.find(id)
    if (!tagPhoto) throw new Error('TagPhoto not found')
    Object.assign(tagPhoto, data)
    await tagPhoto.save()
    return tagPhoto
  }

  // Elimina un TagPhoto por su ID
  public async deleteTagPhoto(id: string): Promise<{ message: string }> {
    const tagPhoto = await TagPhoto.find(id)
    if (!tagPhoto) throw new Error('TagPhoto not found')
    await tagPhoto.delete()
    return { message: 'TagPhoto deleted successfully' }
  }

  public async deleteByPhotoAndCategory(
    photoId: string,
    category?: string
  ): Promise<{ message: string }> {
    const query = TagPhoto.query().where('photoId', photoId)

    if (category) {
      query.where('category', category)
    }

    await query.delete()

    return { message: 'TagPhoto deleted successfully' }
  }

  public async addSustantives(parentTagPhoto: TagPhoto) {
    const nlpService = new NLPService()
    const tagManager = new TagManager()
    if (['person', 'animals', 'objects'].includes(parentTagPhoto.tag.group)) {
      const sustantives = nlpService.getSustantives(parentTagPhoto.tag.name)
      if (!sustantives) return
      for (const sustantive of sustantives) {
        const sustTag = new Tag()
        sustTag.name = sustantive
        sustTag.group = 'misc'
        const existingOrCreatedTag: Tag = await tagManager.getOrCreateSimilarTag(sustTag)
        const tagPhoto = new TagPhoto()
        tagPhoto.tagId = existingOrCreatedTag.id
        tagPhoto.photoId = Number(parentTagPhoto.photoId)
        tagPhoto.category = parentTagPhoto.category
        tagPhoto.parentId = parentTagPhoto.id
        await tagPhoto.save()
      }
    }
  }
}
