// @ts-nocheck

import Photo from '#models/photo'
import TagPhoto from '#models/tag_photo'

import { withCache } from '../decorators/withCache.js'
import TagPhotoManager from './tag_photo_manager.js'

export default class PhotoManager {
  constructor() {}

  // Obtener una foto por ID, cargando sus relaciones
  public async getPhoto(id: string) {
    const photo = await Photo.query()
      .where('id', id)
      .preload('analyzerProcess')
      .preload('descriptionChunks')
      .preload('tagPhotos')
    if (!photo) {
      throw new Error('Photo not found')
    }

    return photo
  }

  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query()
      .whereIn('id', photoIds)
      .preload('tagPhotos')
      .preload('analyzerProcess')
    return photos
  }

  @withCache({
    key: (arg1) => `getPhotosByUser_${arg1}`,
    provider: 'redis',
    ttl: 50 * 5,
  })
  public async getPhotosByUser(userId: string[]) {
    let photos = await Photo.query()
      .preload('tagPhotos')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
    return photos.map((photo) => ({
      ...photo.$attributes,
      tagPhotos: photo.tagPhotos,
      descriptionChunks: photo.descriptionChunks,
      descriptions: photo.descriptions,
      tempID: Math.random().toString(36).substr(2, 4),
    }))
  }

  public async _getPhotosByUser(userId: string) {
    let photos = await Photo.query()
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .preload('tagPhotos')
      .orderBy('created_at', 'asc')
    return photos
  }

  public async updatePhoto(id: string, updates: Partial<Photo>) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }

    // Actualizamos únicamente los campos simples (no descriptions ni tags)
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'descriptions' && key !== 'tags') {
        ;(photo as any)[key] = value
      }
    })

    try {
      await photo.save()
    } catch (err) {
      console.error(`[AnalyzerProcess] Error saving photo ${id}`, err)
    }
    return photo
  }

  public async addPhotoDescriptions(id: string, newDescriptions: Partial<Photo['descriptions']>) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }
    photo.descriptions = {
      ...(photo.descriptions || {}),
      ...newDescriptions,
    }
    try {
      await photo.save()
    } catch (err) {
      console.error(`[AnalyzerProcess] Error updating descriptions for photo ${id}`, err)
    }
    return photo
  }

  public async addTagsPhoto(
    photoId: string,
    newTags: Partial<TagPhoto>[],
    replaceAll: boolean = false
  ) {
    const tagPhotoManager = new TagPhotoManager()
    const photo = await Photo.find(photoId)
    if (!photo) {
      throw new Error('Photo not found')
    }
    if (replaceAll) {
      await photo.related('tagPhotos').query().delete()
    }
    await photo.related('tagPhotos').createMany(newTags)

    for (const tagPhoto of newTags) {
      await tagPhotoManager.addSustantives(tagPhoto)
    }

    await photo.load('tagPhotos')
    return photo
  }

  public

  // Eliminar una foto por ID
  public async deletePhoto(id: string) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }
    await photo.delete()
    return { message: 'Photo deleted successfully' }
  }
}
