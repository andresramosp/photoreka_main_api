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
  public async getAllTagPhotos(photoId?: number): Promise<TagPhoto[]> {
    const query = TagPhoto.query()
    if (photoId) query.where('photo_id', photoId)
    return await query
  }

  // Actualiza un TagPhoto existente
  public async updateTagPhoto(id: number, data: Partial<TagPhoto>): Promise<TagPhoto> {
    const tagPhoto = await TagPhoto.find(id)
    if (!tagPhoto) throw new Error('TagPhoto not found')
    Object.assign(tagPhoto, data)
    await tagPhoto.save()
    return tagPhoto
  }

  // Elimina un TagPhoto por su ID
  public async deleteTagPhoto(id: number): Promise<{ message: string }> {
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

  public async addSustantives(
    parentTagPhoto: TagPhoto,
    sustantives: string[],
    embeddingMap: Map<string, number[]>
  ) {
    const tagManager = new TagManager()

    for (const sust of sustantives) {
      const sustTag = new Tag()
      sustTag.name = sust
      sustTag.group = 'misc'

      // se pasa el embedding precalculado como 2.º argumento
      const existingTag = await tagManager.getOrCreateSimilarTag(sustTag, embeddingMap.get(sust))

      const tagPhoto = new TagPhoto()
      tagPhoto.tagId = existingTag.id
      tagPhoto.photoId = Number(parentTagPhoto.photoId)
      tagPhoto.category = parentTagPhoto.category
      tagPhoto.parentId = parentTagPhoto.id

      try {
        await tagPhoto.save()
      } catch (err) {
        if (err.code === '23505') {
          // console.log(
          //   `[TagPhotoManager] Sustantivo duplicado ignorado: ${sust} (tag ${parentTagPhoto.tag.name})`
          // )
        } else {
          console.error('[TagPhotoManager] Error inesperado:', err)
        }
      }
    }
  }
}
