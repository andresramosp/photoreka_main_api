// @ts-nocheck

import DetectionPhoto from '#models/detection_photo'
import Photo, { PhotoDescriptions, PhotoDetections } from '#models/photo'
import TagPhoto from '#models/tag_photo'
import ModelsService from '#services/models_service'
import NLPService from '#services/nlp_service'

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

  @withCache({
    key: (arg1) => `getPhotosByUser_${arg1}`,
    provider: 'redis',
    ttl: 50 * 5,
  })
  public async getPhotosByUser(userId: string[]) {
    let photos = await Photo.query()
      .preload('tags', (query) => {
        query.preload('tag')
      })
      .preload('descriptionChunks')
      .preload('detections')
      .preload('analyzerProcess')
    return photos.map((photo) => ({
      ...photo.$attributes,
      tags: photo.tags,
      descriptionChunks: photo.descriptionChunks,
      descriptions: photo.descriptions,
      tempID: Math.random().toString(36).substr(2, 4),
    }))
  }

  public async _getPhotosByUser(userId: string) {
    let photos = await Photo.query()
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .preload('detections')
      .preload('tags', (query) => {
        query.preload('tag')
      })
      .orderBy('created_at', 'desc')
    // .limit(10)
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

  public async updateTagsPhoto(photoId: string, newTags: Partial<TagPhoto>[], replaceAll = false) {
    const photo = await Photo.find(photoId)
    if (!photo) throw new Error('Photo not found')

    if (replaceAll) await photo.related('tags').query().delete()
    await photo.related('tags').createMany(newTags)
    await photo.load('tags', (tagPhoto) => tagPhoto.preload('tag'))

    const nlpService = new NLPService()
    const tagPhotosToProcess = photo.tags.filter((tp) =>
      ['person', 'animals', 'objects'].includes(tp.tag.group)
    )

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
    // -------------------------------------------------------------------

    const tagPhotoManager = new TagPhotoManager()

    for (const tp of tagPhotosToProcess) {
      await tagPhotoManager.addSustantives(tp, tagToSust.get(tp)!, embeddingMap)
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
