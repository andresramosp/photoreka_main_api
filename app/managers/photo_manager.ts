import DetectionPhoto from '#models/detection_photo'
import Photo, { PhotoDescriptions } from '#models/photo'
import TagPhoto from '#models/tag_photo'
import ModelsService from '#services/models_service'
import NLPService from '#services/nlp_service'
import { Logger } from '@adonisjs/core/logger'

import { invalidateCache, withCache } from '../decorators/withCache.js'
import TagPhotoManager from './tag_photo_manager.js'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3'
import db from '@adonisjs/lucid/services/db'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})

export default class PhotoManager {
  constructor() {}

  // Obtener una foto por ID, cargando sus relaciones
  public async getPhoto(id: string) {
    const photo = await Photo.query()
      .where('id', id)
      .preload('tags', (q) => q.preload('tag').preload('parent'))
      .preload('detections')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .firstOrFail()
    if (!photo) {
      throw new Error('Photo not found')
    }

    return photo
  }

  public async getPhotosByIds(photoIds: number[]) {
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
    provider: 'redis',
    ttl: 60 * 30,
    key: (userId) => `getPhotosByUser_${userId}`,
  })
  public async getPhotosByUser(userId: string) {
    const query = Photo.query()
      .where('user_id', userId)
      .preload('tags', (q) => q.preload('tag').preload('parent'))
      .preload('detections')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    return await query
  }

  public async getPhotosPreview(userId: string) {
    const photos = await Photo.query()
      .where('user_id', userId)
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')
    return photos.map((p) => ({
      id: p.id,
      originalUrl: p.originalUrl,
      thumbnailUrl: p.thumbnailUrl,
      status: p.status,
      originalFileName: p.originalFileName,
      visualAspects: p.descriptions?.visual_aspects || [],
    }))
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotosIdsByUser(
    userId: string,
    collections?: string[],
    visualAspects?: string[]
  ): Promise<number[]> {
    let query = Photo.query().where('user_id', userId)
    if (collections && collections.length > 0) {
      query = query.whereHas('collections', (collectionQuery) => {
        collectionQuery.whereIn('collections.id', collections)
      })
    }

    const photos = await query.select('id', 'descriptions')

    if (!visualAspects || !Array.isArray(visualAspects) || visualAspects.length === 0) {
      return photos.map((p) => p.id)
    }

    return photos
      .filter((p) => {
        const va = p.descriptions?.visual_aspects
        if (!va || typeof va !== 'object') return false
        // Unir todos los valores de todos los arrays en un solo array
        const allValues = Object.values(va).flat().filter(Boolean)
        // Verificar que todos los visualAspects estén presentes
        return visualAspects.every((aspect) => allValues.includes(aspect))
      })
      .map((p) => p.id)
  }

  /**
   * Métodos optimizados para obtener fotos según el modo de análisis
   * Evita traer todas las fotos para filtrar después
   */

  public async getPhotosForAdding(userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .where((query) => {
        query.whereNull('analyzer_process_id').orWhereHas('analyzerProcess', (subQuery) => {
          subQuery.where('is_preprocess', true)
        })
      })
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  public async getPhotosForPreprocess(userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .whereNull('analyzer_process_id')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  public async getPhotosForRemakeAll(userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .preload('tags', (q) => q.preload('tag'))
      .preload('detections')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  public async getPhotosForRemakeProcess(processId: string, userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .where('analyzer_process_id', processId)
      .preload('tags', (q) => q.preload('tag'))
      .preload('detections')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  public async getPhotosForRetryProcess(processId: string, userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .where('analyzer_process_id', processId)
      .preload('tags', (q) => q.preload('tag'))
      // .preload('detections')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  /**
   * Método principal que decide qué consulta optimizada usar según el modo
   */
  public async getPhotosForAnalysis(
    mode: string,
    processId?: string,
    userId?: string,
    isPreprocess?: boolean
  ): Promise<Photo[]> {
    switch (mode) {
      case 'adding':
        return isPreprocess ? this.getPhotosForPreprocess(userId) : this.getPhotosForAdding(userId)
      case 'remake_all':
        return this.getPhotosForRemakeAll(userId)
      case 'remake_process':
        if (!processId) throw new Error('processId required for remake_process mode')
        return this.getPhotosForRemakeProcess(processId)
      case 'retry_process':
        if (!processId) throw new Error('processId required for retry_process mode')
        return this.getPhotosForRetryProcess(processId)
      default:
        throw new Error(`Unknown analysis mode: ${mode}`)
    }
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
    const tagPhotosToProcess = photo.tags

    /* ---------- Sustantivos y embeddings si faltan ---------- */
    if (!tagToSustantivesMap || !embeddingsMap) {
      const tagToSust = new Map<string, string[]>()
      const allSustSet = new Set<string>()
      const nlpService = new NLPService()

      for (const tp of tagPhotosToProcess) {
        const sust = nlpService.getSustantives(tp.tag.name) ?? []
        tagToSust.set(tp.tag.name, sust)
        sust.forEach((s) => allSustSet.add(s))
      }

      const allSustantives = [...allSustSet]
      const { embeddings } = await new ModelsService().getEmbeddingsCPU(allSustantives)

      tagToSustantivesMap = tagToSust
      embeddingsMap = new Map(allSustantives.map((s, i) => [s, embeddings[i]]))
    }
    /* -------------------------------------------------------- */

    const tagPhotoManager = new TagPhotoManager()

    /* ----------- Paralelización de addSustantives ----------- */
    await Promise.allSettled(
      tagPhotosToProcess.flatMap((tp) => {
        const sustantives = tagToSustantivesMap!.get(tp.tag.name) ?? []
        return sustantives.length > 0
          ? [tagPhotoManager.addSustantives(tp, sustantives, embeddingsMap!)]
          : []
      })
    )

    /* -------------------------------------------------------- */

    return photo
  }

  public async deletePhotos(ids: number[], userId?: string) {
    if (!ids.length) throw new Error('No photo IDs provided')

    // Busca los nombres de archivos a eliminar
    const photos = await Photo.query().whereIn('id', ids)
    if (!photos.length) throw new Error('No photos found')

    // Elimina de golpe con raw query
    await db.from('photos').whereIn('id', ids).delete()

    const objectsToDelete: string[] = []
    for (const photo of photos) {
      objectsToDelete.push(photo.name)
      if (photo.thumbnailName) objectsToDelete.push(photo.thumbnailName)
    }

    try {
      s3.send(
        new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET,
          Delete: {
            Objects: objectsToDelete.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      )
    } catch (err) {
      console.warn('⚠️ Fallo al eliminar archivos en R2:', err)
    }

    await invalidateCache(`getPhotos_${userId}`)
    await invalidateCache(`getPhotosIdsByUser_${userId}`)

    return { message: 'Photos deleted successfully', ids }
  }
}
