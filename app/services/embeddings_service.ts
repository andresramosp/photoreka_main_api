// @ts-nocheck

import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

const cache = new NodeCache({ stdTTL: 3600 })

const partitions: any = {
  creatures: ['cat', 'feline'], // Desde "gato" hasta "animal"
  objects: ['chair', 'furniture'], // Desde "silla" hasta "mobiliario"
  vehicles: ['taxi', 'vehicle'], // Desde "coche" hasta "vehículo"
  emotions: ['joy', 'emotion'], // Desde "alegría" hasta "emoción"
  events: ['birthday', 'event'], // Desde "cumpleaños" hasta "evento"
  locations: ['paris', 'place'], // Desde "París" hasta "lugar"
  environment: ['tree', 'nature'],
}

interface ScoredPhoto {
  tagScore: number // Puntuación por tags
  // descScore: number // Puntuación por embeddings
  totalScore: number // Puntaje total calculado
}

interface ChunkedPhoto extends ScoredPhoto {
  chunks?: { proximity: number; text_chunk: string }[] // Chunks asociados a la foto
}

export default class EmbeddingsService {
  public modelsService: ModelsService = null

  constructor() {
    this.modelsService = new ModelsService()
  }

  // @MeasureExecutionTime
  public async findSimilarTagsToText(
    term: string,
    threshold: number = 0.3,
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
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number } // Parámetro opcional para filtrar por photo_id
  ) {
    const modelsService = new ModelsService()
    let result = null

    let { embeddings } = await modelsService.getEmbeddings([term])
    return this.findSimilarChunkToEmbedding(embeddings[0], threshold, limit, metric, photo)
  }

  // @MeasureExecutionTime
  public async findSimilarTagsToTag(
    tag: Tag,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!tag || !tag.id) {
      throw new Error('Tag no encontrado o no tiene ID asociado')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 't2.embedding <-> t1.embedding AS proximity'
      whereCondition = 't2.embedding <-> t1.embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(t2.embedding <#> t1.embedding) * -1 AS proximity'
      whereCondition = '(t2.embedding <#> t1.embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (t2.embedding <=> t1.embedding) AS proximity'
      whereCondition = '1 - (t2.embedding <=> t1.embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

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
        threshold,
        limit,
      }
    )

    return result.rows
  }

  // Con photo, saca las proximidades de sus chunks con el termino,
  // sin foto, busca en todos los chunks de descripciones
  // @MeasureExecutionTime
  public async findSimilarChunkToEmbedding(
    embedding: number[],
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number }
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 'embedding <-> :embedding AS proximity'
      whereCondition = 'embedding <-> :embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
      whereCondition = '(embedding <#> :embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (embedding <=> :embedding) AS proximity'
      whereCondition = '1 - (embedding <=> :embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

    // Añadir filtro por photo_id si se proporciona
    if (photo) {
      whereCondition += ` AND photo_id = :photoId`
    }

    // Formatear el embedding para PostgreSQL (pgvector requiere formato de string: '[value1,value2,...]')
    const embeddingString = `[${embedding.join(',')}]`

    const queryParameters: any = {
      embedding: embeddingString, // Embedding en formato pgvector
      threshold, // Umbral de similitud
      limit, // Número máximo de resultados
    }

    if (photo) {
      queryParameters.photoId = photo.id // Añadir photoId si se proporciona
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
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    tagIds?: number[] // IDs opcionales para filtrar la búsqueda
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 'embedding <-> :embedding AS proximity'
      whereCondition = 'embedding <-> :embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
      whereCondition = '(embedding <#> :embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (embedding <=> :embedding) AS proximity'
      whereCondition = '1 - (embedding <=> :embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

    // Formatear el embedding para PostgreSQL (pgvector requiere formato de string: '[value1,value2,...]')
    const embeddingString = `[${embedding.join(',')}]`

    // Agregar condición adicional si `tagIds` está presente
    const tagFilterCondition = tagIds && tagIds.length > 0 ? 'AND id = ANY(:tagIds)' : ''

    const result = await db.rawQuery(
      `
      SELECT id, name, "group", created_at, updated_at, ${metricQuery}
      FROM tags
      WHERE ${whereCondition} ${tagFilterCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      {
        embedding: embeddingString, // Embedding en formato pgvector
        threshold, // Umbral de similitud
        limit, // Número máximo de resultados
        tagIds: tagIds || [], // IDs de tags opcionales
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

  // public async getScoredTagsPhotos(
  //   photos: Photo[],
  //   description: string,
  //   similarityThreshold: number = 0.2
  // ): Promise<{ photo: Photo; tagScore: number }[]> {
  //   const matchingTags = await this.findSimilarTagsToText(
  //     description,
  //     similarityThreshold,
  //     500, // Limitar la cantidad de tags considerados
  //     'cosine_similarity'
  //   )

  //   const matchingTagMap: Map<string, number> = new Map(
  //     matchingTags.map((tag: any) => [tag.name, tag.proximity])
  //   )

  //   const relevantPhotos = photos.filter((photo) =>
  //     photo.tags?.some((tag) => matchingTagMap.has(tag.name))
  //   )

  //   const results = relevantPhotos.map((photo) => {
  //     const photoMatchingTags = photo.tags?.filter((tag) => matchingTagMap.has(tag.name)) || []

  //     // Calcula proximidades relevantes con ponderación exponencial
  //     const proximities = photoMatchingTags.map((tag) =>
  //       Math.exp((matchingTagMap.get(tag.name) || 0) - 0.5)
  //     )

  //     // Máximo y media ponderada
  //     const maxProximity = Math.max(...proximities, 0)
  //     const averageProximity =
  //       proximities.reduce((sum, proximity) => sum + proximity, 0) / (proximities.length || 1)

  //     // Score combinado
  //     const tagScore = 0.75 * maxProximity + 0.25 * averageProximity

  //     return { photo, tagScore }
  //   })

  //   return results.sort((a, b) => b.tagScore - a.tagScore)
  // }

  // A partir de una partición de la query logica saca los tags relevantes y ordena todas las fotos
  // Da prioridad a fotos con todos los segmmentos matched
  // Tags repetidos en una misma foto atenuan la suma con raíz cuadrada
  // public async getScoredTagsPhotosLogical(
  //   photos: Photo[],
  //   description: string,
  //   similarityThreshold: number = 0.3
  // ): Promise<{ photo: Photo; tagScore: number }[]> {
  //   const segments = description.split(/\b(AND|OR|NOT)\b/).map((s) => s.trim())
  //   const results: Record<string, any[]> = { AND: [], OR: [], NOT: [] }
  //   const promises: Promise<any>[] = []

  //   // Procesar cada segmento lógico
  //   for (let i = 0; i < segments.length; i++) {
  //     const segment = segments[i]
  //     if (['AND', 'OR', 'NOT'].includes(segment)) continue

  //     const operator =
  //       segments[i - 1] && ['AND', 'OR', 'NOT'].includes(segments[i - 1]) ? segments[i - 1] : 'AND' // Asume AND como predeterminado

  //     promises.push(
  //       (async () => {
  //         const { embeddings } = await this.modelsService.getEmbeddings([segment])
  //         const similarTags = await this.findSimilarTagToEmbedding(
  //           embeddings[0],
  //           similarityThreshold,
  //           100,
  //           'cosine_similarity'
  //         )
  //         results[operator].push(...similarTags)
  //       })()
  //     )
  //   }

  //   await Promise.all(promises)

  //   // Obtener sets para operadores lógicos
  //   const andResults = new Set(results.AND.flat())
  //   const orResults = new Set(results.OR.flat())
  //   const notResults = new Set(results.NOT.flat())

  //   // Intersección lógica AND-OR
  //   const intersection = [...andResults].filter((tag) => orResults.has(tag) || orResults.size === 0)

  //   // Normalizar proximidades al rango [0, 1]
  //   const proximities = intersection.map((tag) => tag.proximity)
  //   const maxProximity = Math.max(...proximities, 1) // Evitar división por 0
  //   const tagScoresMap = new Map<string, number>()

  //   intersection.forEach((tag: any) => {
  //     const normalizedProximity = tag.proximity / maxProximity // Normalización
  //     tagScoresMap.set(tag.name, normalizedProximity)
  //   })

  //   // Filtrar fotos relevantes y calcular puntajes
  //   const resultsWithScores = photos.map((photo) => {
  //     const segmentScores: number[] = [] // Almacena el puntaje por segmento lógico
  //     let matchedSegments = 0 // Contador de segmentos matcheados lógicamente
  //     const totalSegments = Object.keys(results).filter((key) => key !== 'NOT').length // Número de segmentos sin incluir NOT
  //     let hasInvalidNotTag = false // Flag para detectar penalizaciones por NOT

  //     // Iterar por segmentos lógicos y calcular el puntaje
  //     for (const segment of Object.keys(results)) {
  //       const matchingTags =
  //         photo.tags?.filter((tag) =>
  //           results[segment].some((resultTag) => resultTag.name === tag.name)
  //         ) || []

  //       if (segment === 'NOT') {
  //         // Detectar si algún tag en NOT tiene proximidad >= 0.6
  //         const maxProximity = Math.max(
  //           ...matchingTags.map((tag) => tagScoresMap.get(tag.name) || 0)
  //         )
  //         if (maxProximity >= 0.6) {
  //           hasInvalidNotTag = true // Penalizar la foto
  //         }
  //         continue // Saltar el resto de la lógica para NOT
  //       }

  //       if (matchingTags.length > 0) {
  //         // Verificar si el segmento matchea lógicamente (proximidad >= 0.6)
  //         const maxProximity = Math.max(
  //           ...matchingTags.map((tag) => tagScoresMap.get(tag.name) || 0)
  //         )

  //         if (maxProximity >= 0.6) {
  //           matchedSegments++ // Incrementar si el segmento matchea
  //         }

  //         // Calcular el puntaje con atenuación
  //         const segmentProximities = matchingTags.map((tag) => tagScoresMap.get(tag.name) || 0)

  //         const segmentScore = Math.sqrt(
  //           segmentProximities.reduce((sum, proximity) => sum + proximity, 0)
  //         ) // Usar raíz cuadrada como atenuación
  //         segmentScores.push(segmentScore)
  //       }
  //     }

  //     // Calcular el puntaje total
  //     const totalScore = segmentScores.reduce((sum, score) => sum + score, 0)

  //     return {
  //       photo,
  //       tagScore: hasInvalidNotTag ? -1 : totalScore, // Penalización absoluta si hay tags en NOT
  //       matchedSegments,
  //       totalSegments,
  //     }
  //   })

  //   // Ordenar fotos priorizando cobertura lógica y luego puntaje
  //   resultsWithScores.sort((a, b) => {
  //     // Priorizar fotos que cumplen todos los segmentos
  //     const aCompleteMatch = a.matchedSegments === a.totalSegments
  //     const bCompleteMatch = b.matchedSegments === b.totalSegments

  //     if (aCompleteMatch && !bCompleteMatch) return -1
  //     if (!aCompleteMatch && bCompleteMatch) return 1

  //     // Penalizar fotos con tags del segmento NOT
  //     if (a.tagScore === -1 && b.tagScore !== -1) return 1
  //     if (a.tagScore !== -1 && b.tagScore === -1) return -1

  //     // Si ambos cumplen o no cumplen, ordenar por puntaje
  //     return b.tagScore - a.tagScore
  //   })

  //   // Retornar las fotos con sus puntajes
  //   return resultsWithScores
  //     .filter(({ tagScore }) => tagScore !== -1) // Excluir fotos penalizadas por NOT
  //     .map(({ photo, tagScore }) => ({ photo, tagScore }))
  // }

  // Dada una foto saca sus tags relevantes a partir de una partición de la query lógica

  public async getScoredDescPhotos(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.12
  ): Promise<{ photo: Photo; descScore: number }[]> {
    const matchingChunks = await this.findSimilarChunksToText(
      description,
      similarityThreshold,
      500, // Limitar la cantidad de chunks considerados
      'cosine_similarity'
    )

    const matchingChunkMap: Map<string | number, number> = new Map(
      matchingChunks.map((chunk: any) => [chunk.id, chunk.proximity])
    )

    const relevantPhotos = photos.filter((photo) =>
      photo.descriptionChunks?.some((chunk) => matchingChunkMap.has(chunk.id))
    )

    const results = relevantPhotos.map((photo) => {
      const photoMatchingChunks =
        photo.descriptionChunks?.filter((chunk) => matchingChunkMap.has(chunk.id)) || []

      // Calcula proximidades relevantes con ponderación exponencial
      const proximities = photoMatchingChunks.map((chunk) =>
        Math.exp((matchingChunkMap.get(chunk.id) || 0) - 0.5)
      )

      // Máximo y media ponderada
      const maxProximity = Math.max(...proximities, 0)
      const averageProximity =
        proximities.reduce((sum, proximity) => sum + proximity, 0) / (proximities.length || 1)

      // Score combinado
      const descScore = 0.75 * maxProximity + 0.25 * averageProximity

      return { photo, descScore }
    })

    return results.sort((a, b) => b.descScore - a.descScore)
  }

  @MeasureExecutionTime
  public async getSemanticScoredPhotos(
    photos: Photo[],
    description: string
  ): Promise<ChunkedPhoto[] | undefined> {
    const weights = {
      tags: 0.6,
      desc: 0.4,
    }

    const [scoredTagsPhotos, scoredDescPhotosChunked] = await Promise.all([
      this.getScoredTagsByQuerySegments(photos, description),
      this.getScoredDescPhotos(photos, description),
    ])

    const tagScoresMap = new Map(scoredTagsPhotos.map((item) => [item.photo.id, item.tagScore]))
    const descScoresMap = new Map(
      scoredDescPhotosChunked.map((item) => [item.photo.id, item.descScore])
    )

    const scoredPhotos: ChunkedPhoto[] = photos.map((photo) => {
      const tagScore = tagScoresMap.get(photo.id) || 0
      const descScore = descScoresMap.get(photo.id) || 0

      return {
        photo,
        tagScore,
        descScore,
        totalScore: tagScore * weights.tags + descScore * weights.desc,
      }
    })

    const filteredAndSortedPhotos: ChunkedPhoto[] = scoredPhotos
      .filter((photo) => photo.totalScore > 0.05)
      .sort((a, b) => b.totalScore - a.totalScore)

    return filteredAndSortedPhotos
  }

  @MeasureExecutionTime
  public async getSemanticScoredPhotosLogical(
    photos: Photo[],
    enrichedQuery: string
  ): Promise<ChunkedPhoto[] | undefined> {
    const weights = {
      tags: 1.0,
    }

    const scoredTagsPhotos = await this.getScoredTagsByQuerySegments(photos, enrichedQuery)

    const tagScoresMap = new Map(scoredTagsPhotos.map((item) => [item.photo.id, item.tagScore]))

    const scoredPhotos: ChunkedPhoto[] = photos.map((photo) => {
      const tagScore = tagScoresMap.get(photo.id) || 0

      return {
        photo,
        tagScore,
        descScore: 0,
        totalScore: tagScore * weights.tags,
      }
    })

    const filteredAndSortedPhotos: ChunkedPhoto[] = scoredPhotos
      .filter((photo) => photo.totalScore > 0.05)
      .sort((a, b) => b.totalScore - a.totalScore)

    return filteredAndSortedPhotos
  }

  public async getScoredTagsByQuerySegments(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.3
  ): Promise<{ photo: Photo; tagScore: number }[]> {
    // Detectar si es una descripción segmentada con '|'
    const isSimpleDescription = !description.includes('|')
    const segments = isSimpleDescription
      ? description.split(/\b(AND|OR|NOT)\b/).map((s) => s.trim()) // Estructura lógica
      : description.split('|').map((segment) => segment.trim()) // Todos en AND

    // Inicializar estructura lógica para operadores
    const results: Record<'AND' | 'OR' | 'NOT', Map<string, number>> = {
      AND: new Map(),
      OR: new Map(),
      NOT: new Map(),
    }

    // Lista de segmentos lógicos procesados
    const logicalSegments: Array<{ segment: string; operator: 'AND' | 'OR' | 'NOT' }> = []

    // Procesar cada segmento para obtener tags similares
    await Promise.all(
      segments.map(async (segment, index) => {
        if (['AND', 'OR', 'NOT'].includes(segment)) return // Saltar operadores

        const operator =
          isSimpleDescription && index > 0 && ['AND', 'OR', 'NOT'].includes(segments[index - 1])
            ? segments[index - 1] // Operador explícito
            : 'AND' // Operador predeterminado para casos con '|'

        logicalSegments.push({ segment, operator }) // Guardar segmento lógico

        const matchingTags = await this.findSimilarTagsToText(
          segment,
          similarityThreshold,
          100,
          'cosine_similarity'
        )

        // Guardar los tags en el operador correspondiente
        matchingTags.forEach((tag: any) => {
          results[operator].set(tag.name, tag.proximity)
        })
      })
    )

    // Calcular el total de segmentos relevantes (excluyendo NOT)
    const totalSegments = logicalSegments.filter(({ operator }) => operator !== 'NOT').length

    // Filtrar fotos relevantes: deben cumplir al menos un segmento AND u OR
    const relevantPhotos = photos.filter((photo) => {
      const hasValidTags = photo.tags?.some(
        (tag) => results.AND.has(tag.name) || results.OR.has(tag.name)
      )
      return hasValidTags || results.AND.size === 0 // Si no hay AND, basta con OR
    })

    // Calcular puntajes para cada foto
    const scoredPhotos = relevantPhotos.map((photo) => {
      let totalScore = 0
      let matchedSegments = 0
      let hasInvalidNotTag = false

      // Evaluar cada segmento lógico
      for (const { segment, operator } of logicalSegments) {
        const tagMap = results[operator]
        const matchingTags = photo.tags?.filter((tag) => tagMap.has(tag.name)) || []

        if (matchingTags.length > 0) {
          const proximities = matchingTags.map((tag) => {
            const proximity = tagMap.get(tag.name) || 0
            return proximity >= 0.6 ? Math.exp(proximity - 0.5) : proximity // Exponencial si >= 0.6
          })

          // Sumar puntuación con atenuación (raíz cuadrada)
          const segmentScore = Math.sqrt(proximities.reduce((sum, proximity) => sum + proximity, 0))

          if (operator === 'NOT') {
            hasInvalidNotTag = hasInvalidNotTag || segmentScore > 0 // Penalización
          } else {
            totalScore += segmentScore
            if (operator === 'AND') matchedSegments++ // Contar segmentos AND
          }
        }
      }

      return {
        photo,
        tagScore: hasInvalidNotTag ? -1 : totalScore,
        matchedSegments, // Solo útil para priorización interna
      }
    })

    // Obtener el puntaje máximo para normalización
    const maxScore = Math.max(
      ...scoredPhotos.map(({ tagScore }) => (tagScore > 0 ? tagScore : 0)),
      1
    ) // Evitar división por 0

    // Normalizar los puntajes y ordenar
    return scoredPhotos
      .map(({ photo, tagScore, matchedSegments }) => ({
        photo,
        tagScore: tagScore > 0 ? tagScore / maxScore : 0, // Normalización
        matchedSegments,
      }))
      .sort((a, b) => {
        const aCompleteMatch = a.matchedSegments === totalSegments
        const bCompleteMatch = b.matchedSegments === totalSegments

        if (aCompleteMatch && !bCompleteMatch) return -1
        if (!aCompleteMatch && bCompleteMatch) return 1

        if (a.tagScore === 0 && b.tagScore !== 0) return 1
        if (a.tagScore !== 0 && b.tagScore === 0) return -1

        return b.tagScore - a.tagScore // Ordenar por puntaje
      })
      .filter(({ tagScore }) => tagScore > 0) // Excluir fotos penalizadas
  }

  private async chunkDescriptions(
    photos: any[],
    description: string,
    similarityThresholdDesc: number = 15
  ): Promise<any[]> {
    const modelsService = new ModelsService()

    const promises = photos.map(async (photo: Photo) => {
      if (!photo.description) return null

      // Obtener proximidades de los chunks
      const chunkProximities = await modelsService.semanticProximitChunks(
        description,
        photo.description,
        description.length * 8
      )

      // Filtrar chunks por umbral de proximidad y ordenarlos
      const selectedChunks = chunkProximities
        .filter(({ proximity }: any) => proximity >= similarityThresholdDesc / 100)
        .sort((a: any, b: any) => b.proximity - a.proximity)

      return {
        ...photo,
        chunks: selectedChunks.map(({ text_chunk }: any) => text_chunk),
      }
    })

    // Esperar a que todas las promesas se resuelvan
    return Promise.all(promises)
  }

  public async getNearChunksFromDesc(photo: Photo, query: string, threshold: number = 0.1) {
    if (!photo.descriptionChunks.length) {
      await this.analyzerService.processDesc(photo.description, photo.id)
    }
    const similarChunks = await this.findSimilarChunksToText(
      query,
      threshold,
      5,
      'cosine_similarity',
      photo
    )
    return similarChunks.map((ch) => {
      return { proximity: ch.proximity, text_chunk: ch.chunk }
    })
  }
}
