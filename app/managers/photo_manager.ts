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

  private async fetchPhotosByUser(userId: string): Promise<Photo[]> {
    return await Photo.query()
      // .where('user_id', userId)
      .preload('tags', (query) => query.preload('tag'))
      .preload('descriptionChunks')
      .preload('detections')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')
  }

  @withCache({
    key: (userId) => `getPhotosCached_${userId}`,
    provider: 'redis',
    ttl: 60 * 30,
  })
  private async getPhotosCached(userId: string): Promise<Photo[]> {
    return this.fetchPhotosByUser(userId)
  }

  // Devuelve las instancias Lucid, aptas para escritura
  public async getPhotos(userId: string, useCache = true): Promise<Photo[]> {
    if (useCache) {
      return this.getPhotosCached(userId)
    } else {
      return this.fetchPhotosByUser(userId)
    }
  }

  @withCache({
    key: (userId) => `getPhotos_${userId}`,
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotos(userId: string, useCache = true) {
    const photos = await this.fetchPhotosByUser(userId, useCache)
    return photos
  }

  @withCache({
    key: (userId) => `getPhotosForSearch_${userId}`,
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotosForSearch(userId: string, useCache = true) {
    const photos = await this.fetchPhotosByUser(userId, useCache)
    return photos.map((photo) => ({
      ...photo.$attributes,
      tags: photo.tags,
      descriptionChunks: photo.descriptionChunks,
      descriptions: photo.descriptions,
    }))
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
