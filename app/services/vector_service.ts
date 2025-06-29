// @ts-nocheck

import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'
import Photo, { DescriptionType } from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
import colorsys from 'colorsys'

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

export default class VectorService {
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
      let { embeddings } = await modelsService.getEmbeddingsRailway([term], true)
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
    photoIds: number[] = null,
    categories: DescriptionType[] = null,
    areas: string[] = null
  ) {
    const modelsService = new ModelsService()
    let { embeddings } = await modelsService.getEmbeddingsRailway([term])
    return this.findSimilarChunkToEmbedding(
      embeddings[0],
      threshold,
      limit,
      metric,
      photoIds,
      categories,
      areas
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

  @MeasureExecutionTime
  public async findSimilarChunkToEmbedding(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photoIds?: number[],
    categories?: string[],
    areas?: string[],
    opposite: boolean = false
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
        if (opposite) {
          thresholdCondition = 'embedding <-> :embedding >= :threshold'
          orderBy = 'proximity DESC'
        } else {
          thresholdCondition = 'embedding <-> :embedding <= :threshold'
          orderBy = 'proximity ASC'
        }
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        if (opposite) {
          thresholdCondition = '(embedding <#> :embedding) * -1 <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '(embedding <#> :embedding) * -1 >= :threshold'
          orderBy = 'proximity DESC'
        }
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        if (opposite) {
          thresholdCondition = '1 - (embedding <=> :embedding) <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '1 - (embedding <=> :embedding) >= :threshold'
          orderBy = 'proximity DESC'
        }
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 'embedding <-> :embedding AS proximity'
        thresholdCondition = 'embedding <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity DESC' : 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(embedding <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (embedding <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (embedding <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    whereCondition = thresholdCondition

    // Filtro por photo_id si se proporciona
    if (photoIds && photoIds.length > 0) {
      whereCondition += ` AND photo_id = ANY(:photoIds)`
      additionalParams.photoIds = photoIds
    }

    // Filtro por categories si se proporcionan
    if (categories && categories.length > 0) {
      whereCondition += ` AND category = ANY(:categories)`
      additionalParams.categories = categories
    }

    if (areas && areas.length > 0) {
      whereCondition += ` AND area = ANY(:areas)`
      additionalParams.areas = areas
    }

    const embeddingString = `[${embedding.join(',')}]`

    const queryParameters: any = {
      embedding: embeddingString,
      limit,
      ...additionalParams,
    }

    const result = await db.rawQuery(
      `
      SELECT id, photo_id, chunk, area, ${metricQuery}
      FROM descriptions_chunks
      WHERE ${whereCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      queryParameters
    )

    return result.rows
  }

  // TODO: para el cuello de botella en prod: probar lo de sacar el where para que "aproveche" el index, que ahora en teoría no lo hace
  // @MeasureExecutionTime
  public async findSimilarTagToEmbedding(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    tagIds?: number[],
    categories?: string[], // garantizamos que pertenece a esa categorías, pero aún no sabemos para qué foto
    areas?: string[],
    photoIds?: number[],
    userId?: number, // 🔥 Se deja opcional para el futuro
    opposite: boolean = false
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
        metricQuery = 'tags.embedding <-> :embedding AS proximity'
        thresholdCondition = 'tags.embedding <-> :embedding <= :threshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(tags.embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition = '(tags.embedding <#> :embedding) * -1 >= :threshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (tags.embedding <=> :embedding) AS proximity'
        if (opposite) {
          thresholdCondition = '1 - (tags.embedding <=> :embedding) <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '1 - (tags.embedding <=> :embedding) >= :threshold'
          orderBy = 'proximity DESC'
        }
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 'tags.embedding <-> :embedding AS proximity'
        thresholdCondition = 'tags.embedding <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(tags.embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(tags.embedding <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (tags.embedding <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (tags.embedding <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    const tagFilterCondition = tagIds && tagIds.length > 0 ? 'AND tags.id = ANY(:tagIds)' : ''
    const categoryFilterCondition =
      categories && categories.length > 0 ? 'AND tags_photos.category = ANY(:categories)' : ''
    const areaFilterCondition =
      areas && areas.length > 0 ? 'AND tags_photos.area = ANY(:areas)' : ''
    const photoFilterCondition =
      photoIds && photoIds.length > 0 ? 'AND photos.id = ANY(:photoIds)' : ''
    const userFilterCondition = userId ? 'AND photos.user_id = :userId' : ''

    whereCondition = `${thresholdCondition} ${tagFilterCondition} ${categoryFilterCondition} ${areaFilterCondition} ${photoFilterCondition} ${userFilterCondition}`

    const embeddingString = `[${embedding.join(',')}]`

    const result = await db.rawQuery(
      `
      SELECT DISTINCT 
        tags_photos.id AS tag_photo_id, 
        tags.id AS tag_id, 
        tags.name, 
        tags."group", 
        tags_photos.photo_id,
        tags_photos.category, 
        tags_photos.area, 
        tags.created_at, 
        tags.updated_at, 
        ${metricQuery}
      FROM tags_photos
      JOIN tags ON tags.id = tags_photos.tag_id
      JOIN photos ON photos.id = tags_photos.photo_id
      WHERE ${whereCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      {
        embedding: `[${embedding.join(',')}]`,
        limit,
        tagIds: tagIds || [],
        categories: categories || [],
        areas: areas || [],
        photoIds: photoIds || [],
        userId: userId || null,
        ...additionalParams,
      }
    )

    return result.rows
  }

  public async findSimilarPhotoToEmbedding(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    opposite: boolean = false
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let thresholdCondition: string = ''
    let orderBy: string = ''
    let additionalParams: any = {}

    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 'photos.embedding <-> :embedding AS proximity'
        if (opposite) {
          thresholdCondition = 'photos.embedding <-> :embedding >= :threshold'
          orderBy = 'proximity DESC'
        } else {
          thresholdCondition = 'photos.embedding <-> :embedding <= :threshold'
          orderBy = 'proximity ASC'
        }
      } else if (metric === 'inner_product') {
        metricQuery = '(photos.embedding <#> :embedding) * -1 AS proximity'
        if (opposite) {
          thresholdCondition = '(photos.embedding <#> :embedding) * -1 <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '(photos.embedding <#> :embedding) * -1 >= :threshold'
          orderBy = 'proximity DESC'
        }
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (photos.embedding <=> :embedding) AS proximity'
        if (opposite) {
          thresholdCondition = '1 - (photos.embedding <=> :embedding) <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '1 - (photos.embedding <=> :embedding) >= :threshold'
          orderBy = 'proximity DESC'
        }
      }
      additionalParams.threshold = threshold
    } else {
      // Suponiendo threshold con propiedades min y max
      if (metric === 'distance') {
        metricQuery = 'photos.embedding <-> :embedding AS proximity'
        thresholdCondition =
          'photos.embedding <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity DESC' : 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(photos.embedding <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(photos.embedding <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (photos.embedding <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (photos.embedding <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    const embeddingString = `[${embedding.join(',')}]`

    const result = await db.rawQuery(
      `
        SELECT photos.id, photos.name, ${metricQuery}
        FROM photos
        WHERE ${thresholdCondition}
        ORDER BY ${orderBy}
        LIMIT :limit
      `,
      {
        embedding: embeddingString,
        limit,
        ...additionalParams,
      }
    )

    return result.rows
  }

  public async findSimilarPhotoToColorPalette(
    embedding: number[],
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    opposite: boolean = false
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Color palette embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let thresholdCondition: string = ''
    let orderBy: string = ''
    let additionalParams: any = {}

    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 'photos.color_palette <-> :embedding AS proximity'
        if (opposite) {
          thresholdCondition = 'photos.color_palette <-> :embedding >= :threshold'
          orderBy = 'proximity DESC'
        } else {
          thresholdCondition = 'photos.color_palette <-> :embedding <= :threshold'
          orderBy = 'proximity ASC'
        }
      } else if (metric === 'inner_product') {
        metricQuery = '(photos.color_palette <#> :embedding) * -1 AS proximity'
        if (opposite) {
          thresholdCondition = '(photos.color_palette <#> :embedding) * -1 <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '(photos.color_palette <#> :embedding) * -1 >= :threshold'
          orderBy = 'proximity DESC'
        }
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (photos.color_palette <=> :embedding) AS proximity'
        if (opposite) {
          thresholdCondition = '1 - (photos.color_palette <=> :embedding) <= :threshold'
          orderBy = 'proximity ASC'
        } else {
          thresholdCondition = '1 - (photos.color_palette <=> :embedding) >= :threshold'
          orderBy = 'proximity DESC'
        }
      }
      additionalParams.threshold = threshold
    } else {
      // threshold con propiedades min y max
      if (metric === 'distance') {
        metricQuery = 'photos.color_palette <-> :embedding AS proximity'
        thresholdCondition =
          'photos.color_palette <-> :embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity DESC' : 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(photos.color_palette <#> :embedding) * -1 AS proximity'
        thresholdCondition =
          '(photos.color_palette <#> :embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (photos.color_palette <=> :embedding) AS proximity'
        thresholdCondition =
          '1 - (photos.color_palette <=> :embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = opposite ? 'proximity ASC' : 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    const embeddingString = `[${embedding.join(',')}]`

    const result = await db.rawQuery(
      `
      SELECT photos.id, photos.name, ${metricQuery}
      FROM photos
      WHERE ${thresholdCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
    `,
      {
        embedding: embeddingString,
        limit,
        ...additionalParams,
      }
    )

    return result.rows
  }

  // public async findSimilarPhotoToColorDominants(
  //   embedding: number[], // Paleta de la foto ancla
  //   candidateIds: number[], // IDs de las fotos candidatas
  //   limit: number = 10,
  //   topN: number = 3 // Número de colores dominantes a comparar
  // ) {
  //   if (!embedding || embedding.length === 0) {
  //     throw new Error('Color palette embedding no proporcionado o vacío')
  //   }

  //   // 1. Extraemos los N colores más relevantes de la foto ancla
  //   const anchorTopColors = this.getTopIntenseColorsFromEmbedding(embedding, topN)

  //   // 2. Recuperamos las paletas de las fotos candidatas
  //   const candidatePhotos = await db
  //     .from('photos')
  //     .select('id', 'color_array')
  //     .whereIn('id', candidateIds)

  //   const results = candidatePhotos.map((photo) => {
  //     // Extraemos los N colores más relevantes de la foto candidata
  //     const candidateTopColors = this.getTopIntenseColorsFromEmbedding(photo.color_array, topN)

  //     // Calculamos la distancia mínima entre cada color del ancla y cada color del candidato
  //     let totalMinDistance = 0

  //     anchorTopColors.forEach((anchorColor) => {
  //       const minDistance = Math.min(
  //         ...candidateTopColors.map((candidateColor) =>
  //           this.getColorDistance(anchorColor, candidateColor)
  //         )
  //       )
  //       totalMinDistance += minDistance
  //     })

  //     // Proximidad final → media de las distancias mínimas
  //     const proximity = totalMinDistance / anchorTopColors.length

  //     return { id: photo.id, proximity }
  //   })

  //   // Ordenamos por proximidad (más cercanos primero)
  //   return results.sort((a, b) => a.proximity - b.proximity).slice(0, limit)
  // }

  // private getTopIntenseColorsFromEmbedding(embedding: number[], topN: number = 3) {
  //   if (!embedding || embedding.length === 0) return []

  //   const weights = [0.5, 0.3, 0.1, 0.07, 0.03] // Pesos por frecuencia

  //   const colorScores = []

  //   for (let i = 0; i < embedding.length; i += 3) {
  //     const colorIndex = i / 3
  //     const weight = weights[colorIndex] || 0

  //     const r = embedding[i] * 255
  //     const g = embedding[i + 1] * 255
  //     const b = embedding[i + 2] * 255

  //     // Intensidad perceptual (brillo)
  //     const intensity = 0.299 * r + 0.587 * g + 0.114 * b

  //     colorScores.push({
  //       index: colorIndex,
  //       color: [embedding[i], embedding[i + 1], embedding[i + 2]],
  //       score: intensity * weight,
  //     })
  //   }

  //   // Ordenamos por score (frecuencia × intensidad)
  //   colorScores.sort((a, b) => b.score - a.score)

  //   // Nos quedamos con los N colores más relevantes
  //   return colorScores.slice(0, topN).map((c) => c.color)
  // }

  // private getColorDistance(colorA: number[], colorB: number[]): number {
  //   return Math.sqrt(
  //     Math.pow(colorA[0] - colorB[0], 2) +
  //       Math.pow(colorA[1] - colorB[1], 2) +
  //       Math.pow(colorA[2] - colorB[2], 2)
  //   )
  // }

  // private getWeightedIntensityFromEmbedding(embedding: number[]): number {
  //   if (!embedding || embedding.length === 0) return 0

  //   // Pesos decrecientes (igual que en la saturación ponderada)
  //   const weights = [0.5, 0.3, 0.1, 0.07, 0.03] // Ajustables

  //   let weightedIntensity = 0

  //   for (let i = 0; i < embedding.length; i += 3) {
  //     const colorIndex = i / 3
  //     const weight = weights[colorIndex] || 0

  //     const r = embedding[i] * 255
  //     const g = embedding[i + 1] * 255
  //     const b = embedding[i + 2] * 255

  //     // Intensidad perceptual (brillo)
  //     const intensity = 0.299 * r + 0.587 * g + 0.114 * b

  //     weightedIntensity += intensity * weight
  //   }

  //   return weightedIntensity
  // }

  public async findSimilarPhotoToDominantColors(
    embedding: number[],
    threshold: number = 0.3,
    limit: number = 10,
    opposite: boolean = false
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Color palette embedding no proporcionado o vacío')
    }

    // Pesos decrecientes por posición (tú puedes ajustarlos)
    // const weights = [0.4, 0.4, 0.4, 0.3, 0.3, 0.3, 0.2, 0.2, 0.2, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05]
    const weights = [0.7, 0.7, 0.7, 0.3, 0.3, 0.3] // Solo los dos primeros colores (R, G, B x 2)

    // Preparamos la suma ponderada como string SQL
    const weightedDistanceSql = weights
      .map(
        (weight, index) =>
          `${weight} * ABS(photos.color_array[${index + 1}] - :embedding${index + 1})`
      )
      .join(' + ')

    const thresholdCondition = opposite
      ? `(${weightedDistanceSql}) >= :threshold`
      : `(${weightedDistanceSql}) <= :threshold`

    const orderBy = opposite ? 'proximity DESC' : 'proximity ASC'

    // Preparamos los parámetros de la query
    const queryParams: any = { threshold, limit }
    embedding.forEach((value, index) => {
      queryParams[`embedding${index + 1}`] = value
    })

    const result = await db.rawQuery(
      `
    SELECT photos.id, photos.name, (${weightedDistanceSql}) AS proximity
    FROM photos
    WHERE ${thresholdCondition}
    ORDER BY ${orderBy}
    LIMIT :limit
    `,
      queryParams
    )

    return result.rows
  }

  public async findSimilarPhotoToPhoto(
    photo: Photo,
    threshold: Threshold = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!photo || !photo.id) {
      throw new Error('Photo no encontrada o no tiene ID asociado')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    let additionalParams: any = {}
    let thresholdCondition = ''

    if (typeof threshold === 'number') {
      if (metric === 'distance') {
        metricQuery = 'p2.embedding <-> p1.embedding AS proximity'
        thresholdCondition = 'p2.embedding <-> p1.embedding <= :threshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(p2.embedding <#> p1.embedding) * -1 AS proximity'
        thresholdCondition = '(p2.embedding <#> p1.embedding) * -1 >= :threshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (p2.embedding <=> p1.embedding) AS proximity'
        thresholdCondition = '1 - (p2.embedding <=> p1.embedding) >= :threshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.threshold = threshold
    } else {
      if (metric === 'distance') {
        metricQuery = 'p2.embedding <-> p1.embedding AS proximity'
        thresholdCondition = 'p2.embedding <-> p1.embedding BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity ASC'
      } else if (metric === 'inner_product') {
        metricQuery = '(p2.embedding <#> p1.embedding) * -1 AS proximity'
        thresholdCondition =
          '(p2.embedding <#> p1.embedding) * -1 BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      } else if (metric === 'cosine_similarity') {
        metricQuery = '1 - (p2.embedding <=> p1.embedding) AS proximity'
        thresholdCondition =
          '1 - (p2.embedding <=> p1.embedding) BETWEEN :minThreshold AND :maxThreshold'
        orderBy = 'proximity DESC'
      }
      additionalParams.minThreshold = threshold.min
      additionalParams.maxThreshold = threshold.max
    }

    whereCondition = thresholdCondition

    const result = await db.rawQuery(
      `
        SELECT p2.id, p2.name ${metricQuery}
        FROM photos p1
        JOIN photos p2 ON p1.id = :id AND p2.id != p1.id
        WHERE ${whereCondition}
        ORDER BY ${orderBy}
        LIMIT :limit
      `,
      {
        id: photo.id,
        limit,
        ...additionalParams,
      }
    )

    return result.rows
  }

  // private async getEmbedding(name: string): Promise<number[] | string | null> {
  //   const modelsService = new ModelsService()

  //   const tag = await Tag.query().where('name', name).first()
  //   if (tag) {
  //     return JSON.parse(tag.embedding)
  //   }

  //   // Otherwise, fetch dynamically
  //   const { embeddings } = await modelsService.getEmbeddings([name], true)
  //   return embeddings[0] || null
  // }

  static getParsedEmbedding(embedding): number[] | null {
    return embedding ? JSON.parse(embedding as string) : null
  }
}
