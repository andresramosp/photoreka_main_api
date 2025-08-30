import DetectionPhoto from '#models/detection_photo'
import Photo, { PhotoDescriptions, DescriptionType } from '#models/photo'
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
      descriptions: {
        visual_aspects: p.descriptions?.visual_aspects || [],
        artistic_scores: p.descriptions?.artistic_scores || [],
      },
    }))
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 30,
  })
  public async getPhotosIdsForSearch(
    userId: string,
    collections?: string[],
    visualAspects?: string[],
    artisticScores?: string[]
  ): Promise<number[]> {
    let query = Photo.query().where('user_id', userId)
    if (collections && collections.length > 0) {
      query = query.whereHas('collections', (collectionQuery) => {
        collectionQuery.whereIn('collections.id', collections)
      })
    }

    const photos = await query.select('id', 'descriptions')

    // Si no hay filtros, devolver todos los IDs
    const noVisualAspects =
      !visualAspects || !Array.isArray(visualAspects) || visualAspects.length === 0
    const noArtisticScores =
      !artisticScores || !Array.isArray(artisticScores) || artisticScores.length === 0
    if (noVisualAspects && noArtisticScores) {
      return photos.map((p) => p.id)
    }

    return photos
      .filter((p) => {
        let visualOk = true
        let artisticOk = true

        // Filtrado por visual aspects
        if (!noVisualAspects) {
          const va = p.descriptions?.visual_aspects
          if (!va || typeof va !== 'object') visualOk = false
          else {
            const allValues = Object.values(va).flat().filter(Boolean)
            visualOk = visualAspects.every((aspect) => allValues.includes(aspect))
          }
        }

        // Filtrado por artistic scores
        if (!noArtisticScores) {
          const scores = p.descriptions?.artistic_scores
          if (!scores || typeof scores !== 'object') artisticOk = false
          else {
            // Debe cumplir que todos los scores seleccionados tengan al menos 7
            artisticOk = artisticScores.every((scoreKey) => {
              const value = scores[scoreKey]
              return typeof value === 'number' && value >= 7
            })
          }
        }

        return visualOk && artisticOk
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

  public async getPhotosForUpgradeWithPackage(userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .preload('analyzerProcess')
      .preload('tags', (q) => q.preload('tag'))
      .preload('descriptionChunks')
      .orderBy('created_at', 'desc')

    if (userId) {
      query.where('user_id', userId)
    }

    return await query
  }

  public async getPhotosForRemakeAll(userId?: string): Promise<Photo[]> {
    if (!userId) throw new Error('userId is required')

    console.log(
      '[AnalyzerProcess] [getPhotosForRemakeAll] Iniciando proceso de remake de todas las fotos para el usuario:',
      userId
    )

    // 1. Obtener los datos necesarios de las fotos
    const photos: Array<{
      user_id: number
      name: string
      original_file_name: string
      thumbnail_name: string
    }> = await Photo.query()
      .where('user_id', userId)
      .select(['user_id', 'name', 'original_file_name', 'thumbnail_name'])
      .pojo()

    console.log('[AnalyzerProcess] [getPhotosForRemakeAll] Fotos obtenidas:', photos.length)

    // 2. Borrar todas las fotos del usuario (raw query para velocidad)
    await db.from('photos').where('user_id', userId).delete()
    console.log(
      '[AnalyzerProcess] [getPhotosForRemakeAll] Todas las fotos del usuario eliminadas de la base de datos'
    )

    // 3. Recrear las fotos solo con los campos requeridos
    const recreatedPhotos: Photo[] = []
    for (const p of photos) {
      const newPhoto = await Photo.create({
        userId: p.user_id,
        name: p.name,
        originalFileName: p.original_file_name,
        thumbnailName: p.thumbnail_name,
      })
      recreatedPhotos.push(newPhoto)
      // console.log('[AnalyzerProcess] [getPhotosForRemakeAll] Foto recreada:', newPhoto.id)
    }

    console.log(
      '[AnalyzerProcess] [getPhotosForRemakeAll] Proceso finalizado. Total fotos recreadas:',
      recreatedPhotos.length
    )
    return recreatedPhotos
  }

  public async getPhotosForRemakeProcess(processId: string, userId?: string): Promise<Photo[]> {
    const query = Photo.query()
      .where('analyzer_process_id', processId)
      .preload('tags', (q) => q.preload('tag'))
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
      case 'adding': // las fotos nuevas
        return isPreprocess ? this.getPhotosForPreprocess(userId) : this.getPhotosForAdding(userId)
      case 'upgrade_with_package': // añade tasks a un proceso, no destructivo
        return this.getPhotosForUpgradeWithPackage(userId)
      case 'remake_all': // todas las fotos, destructivo
        return this.getPhotosForRemakeAll(userId)
      case 'remake_process': // rehacer un proceso, no destructivo
        if (!processId) throw new Error('processId required for remake_process mode')
        return this.getPhotosForRemakeProcess(processId)
      case 'retry_process': // reintetar un proceso, conservador, no destructivo
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

  /**
   * Actualiza las descripciones de una foto con merge profundo automático.
   * Para objetos anidados (como visual_aspects), preserva las claves existentes
   * y solo actualiza/agrega las nuevas claves proporcionadas.
   * Para valores primitivos (strings), los reemplaza completamente.
   */
  public async updatePhotoDescriptions(id: string, newDescriptions: PhotoDescriptions) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }

    // Merge profundo para preservar claves existentes dentro de cada tipo de descripción
    const existingDescriptions = photo.descriptions || {}
    const mergedDescriptions: any = { ...existingDescriptions }

    for (const [key, value] of Object.entries(newDescriptions)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Para objetos (como visual_aspects), hacer merge profundo
        const existingValue = existingDescriptions[key as DescriptionType]
        if (
          typeof existingValue === 'object' &&
          existingValue !== null &&
          !Array.isArray(existingValue)
        ) {
          mergedDescriptions[key] = {
            ...existingValue,
            ...value,
          }
        } else {
          mergedDescriptions[key] = value
        }
      } else {
        // Para strings y otros tipos primitivos, reemplazar directamente
        mergedDescriptions[key] = value
      }
    }

    photo.descriptions = mergedDescriptions
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
    await invalidateCache(`getPhotosIdsForSearch${userId}`)

    return { message: 'Photos deleted successfully', ids }
  }
}
