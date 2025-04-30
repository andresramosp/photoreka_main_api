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

  // @withCache({
  //   key: (arg1) => `_getPhotosByUser${arg1}`,
  //   provider: 'redis',
  //   ttl: 50 * 5,
  // })
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

  public async updateTagsPhoto(
    photoId: string,
    newTags: Partial<TagPhoto>[],
    tagToSustantivesMap?: Map<string, string[]>,
    embeddingsMap?: Map<string, number[]>,
    replaceAll = false
  ) {
    console.time('updateTagsPhoto')

    console.time('1. load photo')
    const photo = await Photo.find(photoId)
    if (!photo) throw new Error('Photo not found')
    console.timeEnd('1. load photo')

    if (replaceAll) {
      console.time('2. delete existing tags')
      await photo.related('tags').query().delete()
      console.timeEnd('2. delete existing tags')
    }

    console.time('3. create new tags')
    try {
      await photo.related('tags').createMany(newTags)
    } catch (err) {
      console.error('❌ Error al crear tags:', err)
    }
    console.timeEnd('3. create new tags')

    console.time('4. preload tags and nested tag')
    await photo.load('tags', (tagPhoto) => tagPhoto.preload('tag'))
    console.timeEnd('4. preload tags and nested tag')

    const nlpService = new NLPService()
    const tagPhotosToProcess = photo.tags

    // Cálculo de sustantivos y embeddings si no se pasaron
    if (!tagToSustantivesMap || !embeddingsMap) {
      console.time('5. NLP: calcular sustantivos')
      const tagToSust = new Map<TagPhoto, string[]>()
      const allSustSet = new Set<string>()

      for (const tp of tagPhotosToProcess) {
        const sust = nlpService.getSustantives(tp.tag.name) ?? []
        tagToSust.set(tp, sust)
        sust.forEach((s) => allSustSet.add(s))
      }
      console.timeEnd('5. NLP: calcular sustantivos')

      console.time('6. Obtener embeddings')
      const allSustantives = Array.from(allSustSet)
      const modelsService = new ModelsService()
      const { embeddings } = await modelsService.getEmbeddings(allSustantives)
      const embeddingMap = new Map<string, number[]>()
      allSustantives.forEach((s, i) => embeddingMap.set(s, embeddings[i]))
      console.timeEnd('6. Obtener embeddings')

      tagToSustantivesMap = tagToSust
      embeddingsMap = embeddingMap
    }

    const tagPhotoManager = new TagPhotoManager()

    console.time('7. Añadir sustantivos a cada tag')
    for (const tp of tagPhotosToProcess) {
      const sustantives = tagToSustantivesMap.get(tp.tag.name) ?? []
      await tagPhotoManager.addSustantives(tp, sustantives, embeddingsMap)
    }
    console.timeEnd('7. Añadir sustantivos a cada tag')

    console.timeEnd('updateTagsPhoto')
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
