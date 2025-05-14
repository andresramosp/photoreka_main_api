import Tag from '#models/tag'
import TagPhoto from '#models/tag_photo'
import NLPService from '#services/nlp_service'
import db from '@adonisjs/lucid/services/db'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
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
    const tagPhotoArray: TagPhoto[] = []

    for (const sust of sustantives) {
      const sustTag = new Tag()
      sustTag.name = sust
      sustTag.group = 'misc'

      const existingTag = await tagManager.getOrCreateSimilarTag(sustTag, embeddingMap.get(sust))

      const tagPhoto = new TagPhoto()
      tagPhoto.tagId = existingTag.id
      tagPhoto.photoId = Number(parentTagPhoto.photoId)
      tagPhoto.category = parentTagPhoto.category
      tagPhoto.parentId = parentTagPhoto.id

      tagPhotoArray.push(tagPhoto)
    }

    try {
      const knex = db.connection().getWriteClient()

      await knex('tags_photos')
        .insert(
          tagPhotoArray.map((t) => ({
            photo_id: t.photoId,
            tag_id: t.tagId,
            category: t.category,
            area: t.area,
            parent_id: t.parentId,
          }))
        )
        .onConflict(['photo_id', 'tag_id', 'category'])
        .ignore()
    } catch (err) {
      if (err.code !== '23505') {
        console.error('[TagPhotoManager] Error inesperado en insert masivo:', err)
      }
      // Opcional: podrías hacer un fallback por separado si quieres insertar los que no sean duplicados
    }
  }
}
