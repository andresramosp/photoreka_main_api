// @ts-nocheck

import Photo from '#models/photo'
import Tag from '#models/tag'
import fs from 'fs/promises'

import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import EmbeddingsService from './embeddings_service.js'
import AnalyzerService from './analyzer_service.js'
import withCost from '../decorators/withCost.js'
import QueryService from './query_service.js'
import withCostWS from '../decorators/withCostWs.js'
import ScoringService from './scoring_service.js'
import { withCache } from '../decorators/withCache.js'
import {
  MESSAGE_SEARCH_MODEL_CREATIVE,
  MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
} from '../utils/ModelsMessages.js'

export default class PhotosService {
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public analyzerService: AnalyzerService = null
  public queryService: QueryService = null
  public scoringService: ScoringService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.analyzerService = new AnalyzerService()
    this.queryService = new QueryService()
    this.scoringService = new ScoringService()
  }

  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query()
      .whereIn('id', photoIds)
      .preload('tags')
      .preload('analyzerProcess') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async _getPhotosByUser(userId: string) {
    let photos = await Photo.query()
      .preload('descriptionChunks')
      .preload('analyzerProcess')
      .preload('tags', (tagsQuery) => {
        tagsQuery.pivotColumns(['category', 'area'])
      })
      .orderBy('created_at', 'asc')
      .limit(100)

    return photos
  }

  public async updatePhoto(id: string, updates: Partial<Photo>) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }

    // Actualizar descripciones si están en el update
    if (updates.descriptions && typeof updates.descriptions === 'object') {
      photo.descriptions = {
        ...(photo.descriptions || {}),
        ...updates.descriptions,
      }
    }

    // Actualizar otros campos de la foto, excepto los tags
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'descriptions' && key !== 'tags') {
        ;(photo as any)[key] = value
      }
    })

    // TODO: mejorar, que sea lista de tags en condiciones
    if (updates.tags && typeof updates.tags === 'object') {
      // Obtener los tags reales de la foto
      const existingTags = await photo.related('tags').query().select('id', 'name')

      // Mapear nombres de tags a IDs
      const tagsWithAreas = Object.entries(updates.tags)
        .map(([tagName, area]) => {
          const tag = existingTags.find((t) => t.name === tagName)
          return tag ? { id: tag.id, area } : null
        })
        .filter(Boolean) as { id: number; area: string }[]

      // Actualizar las áreas en la tabla intermedia `tags_photos`
      for (const { id: tagId, area } of tagsWithAreas) {
        await photo.related('tags').pivotQuery().where('tag_id', tagId).update({ area })
      }
    }

    try {
      await photo.save()
    } catch (err) {
      console.error(`[AnalyzerProcess] Error guardando foto ${id}`, err)
    }

    return photo
  }

  // TODO: quitar el mapeo absurdo, el tempID ya no hace falta

  @withCache({
    key: (arg1) => `getPhotosByUser_${arg1}`,
    provider: 'redis',
    ttl: 50 * 5,
  })
  public async getPhotosByUser(userId: string[]) {
    let photos = await Photo.query()
      .preload('tags')
      .preload('descriptionChunks')
      .preload('analyzerProcess')
    return photos.map((photo) => ({
      ...photo.$attributes,
      tags: photo.tags,
      descriptionChunks: photo.descriptionChunks,
      description: photo.description,
      tempID: Math.random().toString(36).substr(2, 4),
    }))
  }
}
