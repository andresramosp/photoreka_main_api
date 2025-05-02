// @ts-nocheck

import DetectionPhoto from '#models/detection_photo'
import Photo, { PhotoDescriptions, PhotoDetections } from '#models/photo'
import TagPhoto from '#models/tag_photo'
import ModelsService from '#services/models_service'
import NLPService from '#services/nlp_service'
import { Logger } from '@adonisjs/core/logger'

import { withCache } from '../decorators/withCache.js'
import TagPhotoManager from './tag_photo_manager.js'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

export default class PhotoManager {
  constructor() {}

  // Obtener una foto por ID, cargando sus relaciones
  public async getPhoto(id: string) {
    const photo = await Photo.query()
      .where('id', id)
      .preload('analyzerProcess')
      .preload('descriptionChunks')
      .preload('tags')
    if (!photo) {
      throw new Error('Photo not found')
    }

    return photo
  }

  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query()
      .whereIn('id', photoIds)
      .preload('detections')
      .preload('tags', (query) => {
        query.preload('tag')
      })
      .preload('analyzerProcess')
    return photos
  }

  private async fetchPhotosByUser(userId: string, eager: boolean): Promise<Photo[]> {
    const query = Photo.query()
      // .where('user_id', userId)
      .preload('tags', (q) => q.preload('tag'))
      .preload('detections')
      .orderBy('created_at', 'desc')

    if (eager) {
      query.preload('descriptionChunks').preload('analyzerProcess')
    }

    return await query
  }

  @withCache({
    key: (userId) => `getPhotos_${userId}`,
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotos(userId: string) {
    const photos = await this.fetchPhotosByUser(userId, false)
    return photos
  }

  @withCache({
    key: (userId) => `getPhotosIdsByUser_${userId}`,
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotosIdsByUser(userId: string): Promise<number[]> {
    const photos = await Photo.query()
      // .where('user_id', userId)  // <-- preparado para futuro filtro
      .select('id')

    return photos.map((p) => p.id)
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

  public async updatePhotoDescriptions(id: string, newDescriptions: PhotoDescriptions) {
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

  public async updatePhotoDetections(
    photoId: string,
    newDetections: Partial<DetectionPhoto>[],
    replaceAll: boolean = true
  ) {
    const photo = await Photo.find(photoId)
    if (!photo) {
      throw new Error('Photo not found')
    }

    if (replaceAll) {
      await photo.related('detections').query().delete()
    }

    await photo.related('detections').createMany(newDetections)
    await photo.load('detections')

    return photo
  }

  public async updateTagsPhoto(
    photoId: string,
    newTags: Partial<TagPhoto>[],
    tagToSustantivesMap?: Map<string, string[]>,
    embeddingsMap?: Map<string, number[]>,
    replaceAll = false
  ) {
    const photo = await Photo.find(photoId)
    if (!photo) throw new Error('Photo not found')

    if (replaceAll) {
      await photo.related('tags').query().delete()
    }

    try {
      await photo.related('tags').createMany(newTags)
    } catch (err) {
      console.error('❌ Error al crear tags:', err)
    }

    await photo.load('tags', (tagPhoto) => tagPhoto.preload('tag'))

    const nlpService = new NLPService()
    const tagPhotosToProcess = photo.tags

    // Cálculo de sustantivos y embeddings si no se pasaron
    if (!tagToSustantivesMap || !embeddingsMap) {
      const tagToSust = new Map<TagPhoto, string[]>()
      const allSustSet = new Set<string>()

      for (const tp of tagPhotosToProcess) {
        const sust = nlpService.getSustantives(tp.tag.name) ?? []
        tagToSust.set(tp, sust)
        sust.forEach((s) => allSustSet.add(s))
      }

      const allSustantives = Array.from(allSustSet)
      const modelsService = new ModelsService()
      const { embeddings } = await modelsService.getEmbeddings(allSustantives)
      const embeddingMap = new Map<string, number[]>()
      allSustantives.forEach((s, i) => embeddingMap.set(s, embeddings[i]))

      tagToSustantivesMap = tagToSust
      embeddingsMap = embeddingMap
    }

    const tagPhotoManager = new TagPhotoManager()

    for (const tp of tagPhotosToProcess) {
      const sustantives = tagToSustantivesMap.get(tp.tag.name) ?? []
      await tagPhotoManager.addSustantives(tp, sustantives, embeddingsMap)
    }

    return photo
  }

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
