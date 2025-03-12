// @ts-nocheck

import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'
import Photo, { DescriptionType } from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const cache = new NodeCache({ stdTTL: 3600 })

interface ScoredPhoto {
  photo: Photo
  tagScore?: number // Puntuación por tags
  descScore?: number // Puntuación por embeddings
  totalScore?: number // Puntaje total calculado
}

// Definición para threshold que puede ser número o intervalo
type Threshold = number | { min: number; max: number }

export default class EmbeddingsService {
  public modelsService: ModelsService = null

  constructor() {
    this.modelsService = new ModelsService()
  }

  // @MeasureExecutionTime
  public async findSimilarTagsToText(
    term: string,
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    const modelsService = new ModelsService()
    let result = null

    let existingTag = await Tag.query().where('name', term).andWhereNotNull('embedding').first()
    if (existingTag) {
      result = this.findSimilarTagsToTag(existingTag, threshold, limit, metric)
    } else {
      let { embeddings } = await modelsService.getEmbeddings([term])
      result = this.findSimilarTagToEmbedding(embeddings[0], threshold, limit, metric)
    }

    return result
  }

  // @MeasureExecutionTime
  public async findSimilarChunksToText(
    term: string,
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number },
    categories: DescriptionType[] = null
  ) {
    const modelsService = new ModelsService()
    let { embeddings } = await modelsService.getEmbeddings([term])
    return this.findSimilarChunkToEmbedding(
      embeddings[0],
      threshold,
      limit,
      metric,
      photo,
      categories
    )
  }

  // @MeasureExecutionTime
  public async findSimilarTagsToTag(
    tag: Tag,
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!tag || !tag.id) {
      throw new Error('Tag no encontrado o no tiene ID asociado')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    // Determinar los parámetros según el tipo de threshold
    let additionalParams: any = {}
    let thresholdCondition = ''
    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 't2.embedding <-> t1.embedding AS proximity'
        thresholdCondition = 't2.embedding <-> t1.embedding <= :threshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(t2.embedding <#> t1.embedding) * -1 AS proximity'
        thresholdCondition = '(t2.embedding <#> t1.embedding) * -1 >= :threshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (t2.embedding <=> t1.embedding) AS proximity'
        thresholdCondition = '1 - (t2.embedding <=> t1.embedding) >= :threshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 't2.embedding <-> t1.embedding AS proximity'
        thresholdCondition = 't2.embedding <-> t1.embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(t2.embedding <#> t1.embedding) * -1 AS proximity'
        thresholdCondition =
          '(t2.embedding <#> t1.embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (t2.embedding <=> t1.embedding) AS proximity'
        thresholdCondition =
          '1 - (t2.embedding <=> t1.embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    whereCondition = thresholdCondition

    const result = await db.rawQuery(
      `
        SELECT t2.id, t2.name, t2."group", t2.created_at, t2.updated_at, ${metricQuery}
        FROM tags t1
        JOIN tags t2 ON t1.id = :id AND t2.id != t1.id
        WHERE ${whereCondition}
        ORDER BY ${orderBy}
        LIMIT :limit
        `,
      {
        id: tag.id,
        limit,
        ...additionalParams,
      }
    )

    return result.rows
  }

  // @MeasureExecutionTime
  public async findSimilarChunkToEmbedding(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number },
    categories?: string[] // parámetro opcional agregado
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    let additionalParams: any = {}
    let thresholdCondition = ''
    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 'embedding <-> :embedding AS proximity'
        thresholdCondition = 'embedding <-> :embedding <= :threshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition = '(embedding <#> :embedding) * -1 >= :threshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        thresholdCondition = '1 - (embedding <=> :embedding) >= :threshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 'embedding <-> :embedding AS proximity'
        thresholdCondition = 'embedding <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(embedding <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (embedding <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    whereCondition = thresholdCondition

    // Filtro por photo_id si se proporciona
    if (photo) {
      whereCondition += ` AND photo_id = :photoId`
      additionalParams.photoId = photo.id
    }

    // Filtro por categories si se proporcionan
    if (categories && categories.length > 0) {
      whereCondition += ` AND category = ANY(:categories)`
      additionalParams.categories = categories
    }

    const embeddingString = `[${embedding.join(',')}]`

    const queryParameters: any = {
      embedding: embeddingString,
      limit,
      ...additionalParams,
    }

    const result = await db.rawQuery(
      `
      SELECT id, photo_id, chunk, ${metricQuery}
      FROM descriptions_chunks
      WHERE ${whereCondition}
      LIMIT :limit
      `,
      queryParameters
    )

    return result.rows
  }

  // @MeasureExecutionTime
  public async findSimilarTagToEmbedding(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    tagIds?: number[],
    categories?: string[],
    userId?: number // 🔥 Se deja opcional para el futuro
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    let additionalParams: any = {}
    let thresholdCondition = ''

    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 'embedding <-> :embedding AS proximity'
        thresholdCondition = 'embedding <-> :embedding <= :threshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition = '(embedding <#> :embedding) * -1 >= :threshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        thresholdCondition = '1 - (embedding <=> :embedding) >= :threshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 'embedding <-> :embedding AS proximity'
        thresholdCondition = 'embedding <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(embedding <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (embedding <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    const tagFilterCondition = tagIds && tagIds.length > 0 ? 'AND tags.id = ANY(:tagIds)' : ''
    const categoryFilterCondition =
      categories && categories.length > 0 ? 'AND tags_photos.category = ANY(:categories)' : ''
    const userFilterCondition = userId ? 'AND photos.user_id = :userId' : '' // 🔥 Se deja listo para el futuro

    whereCondition = `${thresholdCondition} ${tagFilterCondition} ${categoryFilterCondition} ${userFilterCondition}`

    const embeddingString = `[${embedding.join(',')}]`

    const result = await db.rawQuery(
      `
      SELECT tags.id, tags.name, tags."group", tags_photos.category, tags.created_at, tags.updated_at, ${metricQuery}
      FROM tags
      JOIN tags_photos ON tags_photos.tag_id = tags.id
      JOIN photos ON photos.id = tags_photos.photo_id
      WHERE ${whereCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      {
        embedding: embeddingString,
        limit,
        tagIds: tagIds || [],
        categories: categories || [],
        userId: userId || null, // 🔥 Se pasa null si no hay userId para evitar errores
        ...additionalParams,
      }
    )

    return result.rows
  }

  private async getEmbedding(name: string): Promise<number[] | string | null> {
    const modelsService = new ModelsService()

    const tag = await Tag.query().where('name', name).first()
    if (tag) {
      return JSON.parse(tag.embedding)
    }

    // Otherwise, fetch dynamically
    const { embeddings } = await modelsService.getEmbeddings([name])
    return embeddings[0] || null
  }
}
