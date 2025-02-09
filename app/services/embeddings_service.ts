// @ts-nocheck

import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const cache = new NodeCache({ stdTTL: 3600 })

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

  public async getScoredDescPhotos(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.12
  ): Promise<{ photo: Photo; descScore: number }[]> {
    console.log('entrada a desc')

    const matchingChunks = await this.findSimilarChunksToText(
      description,
      0.2,
      1000,
      'cosine_similarity'
    )

    let adjustedSimilarChunks = await this.modelsService.adjustProximitiesByContextInference(
      description,
      matchingChunks.map((mc) => ({ name: mc.chunk, proximity: mc.proximity, id: mc.id })),
      'desc'
    )

    const matchingChunkMap: Map<string | number, number> = new Map(
      adjustedSimilarChunks
        .filter((sc) => sc.proximity >= 0)
        .map((chunk: any) => [chunk.id, chunk.proximity])
    )

    const relevantPhotos = photos.filter((photo) =>
      photo.descriptionChunks?.some((chunk) => matchingChunkMap.has(chunk.id))
    )

    const scoredPhotos = relevantPhotos.map((photo) => {
      const photoMatchingChunks =
        photo.descriptionChunks?.filter((chunk) => matchingChunkMap.has(chunk.id)) || []

      if (photo.id == '20936682-6b33-43ec-ac5a-83d8ff210144') {
        console.log()
      }
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

    const maxScore = Math.max(
      ...scoredPhotos.map(({ descScore }) => (descScore > 0 ? descScore : 0)),
      1
    )

    return scoredPhotos
      .map(({ photo, descScore }) => ({
        photo,
        descScore: descScore > 0 ? descScore / maxScore : 0, // Normalización
      }))
      .sort((a, b) => b.descScore - a.descScore)
      .filter(({ descScore }) => descScore > 0) // exclusión de negativos (contraditcions)
  }

  @MeasureExecutionTime
  public async getScoredPhotosByTagsAndDesc(
    photos: Photo[],
    enrichmentQuery: any,
    searchType: 'logical' | 'semantic' | 'creative'
  ): Promise<ChunkedPhoto[] | undefined> {
    let weights = {
      tags: 0,
      desc: 0,
    }
    let query = ''

    if (searchType === 'logical') {
      weights = { tags: 1, desc: 0 }
      query = enrichmentQuery.clear
    } else if (searchType === 'semantic') {
      weights = { tags: 0.6, desc: 0.4 }
      query = enrichmentQuery.clear
    } else {
      weights = { tags: 0.3, desc: 0.7 }
      query = enrichmentQuery.clear
    }

    const cacheKey = `scoredPhotoIds:${query.toLowerCase().trim()}_${searchType}`
    const cachedPhotoIds = cache.get<number[]>(cacheKey)

    // if (cachedPhotoIds) {
    //   const cachedPhotosMap = new Map(photos.map((photo) => [photo.id, photo]))
    //   const cachedPhotos = cachedPhotoIds
    //     .map((id) => cachedPhotosMap.get(id))
    //     .filter(Boolean) as Photo[]

    //   return cachedPhotos.map((photo) => ({
    //     photo,
    //     tagScore: 0,
    //     descScore: 0,
    //     totalScore: 0,
    //   }))
    // }

    let scoredTagsPhotos: { photo: Photo; tagScore: number }[] = []
    let scoredDescPhotosChunked: { photo: Photo; descScore: number }[] = []

    // Evitar cálculos innecesarios
    if (weights.tags > 0 && weights.desc > 0) {
      ;[scoredTagsPhotos, scoredDescPhotosChunked] = await Promise.all([
        this.getScoredTagsByQuerySegments(photos, query),
        this.getScoredDescPhotos(photos, query),
      ])
    } else if (weights.tags > 0) {
      scoredTagsPhotos = await this.getScoredTagsByQuerySegments(photos, query)
    } else if (weights.desc > 0) {
      scoredDescPhotosChunked = await this.getScoredDescPhotos(photos, query)
    }

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

    // Filtrar y ordenar
    const filteredAndSortedPhotos: ChunkedPhoto[] = scoredPhotos
      .filter((photo) => photo.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)

    // Guardar solo los IDs en caché
    const photoIds = filteredAndSortedPhotos.map((photo) => photo.photo.id)
    cache.set(cacheKey, photoIds)

    return filteredAndSortedPhotos
  }

  @MeasureExecutionTime
  private async getScoredTagsByQuerySegments(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.3
  ): Promise<{ photo: Photo; tagScore: number }[]> {
    console.log('entrada a tags')

    const isSimpleDescription = !description.includes('|')
    const segments = isSimpleDescription
      ? description.split(/\b(AND|OR|NOT)\b/).map((s) => s.trim())
      : description.split('|').map((segment) => segment.trim())

    const results: Record<String, Map<string, number>> = {}

    const allTags = await Tag.all() // TODO: solo los que contengan alguna palabra de los terms
    let allRelevantTags: string[] = []

    const logicalSegments: Array<{ segment: string; operator: 'AND' | 'OR' | 'NOT' }> = []
    await Promise.all(
      segments.map(async (segment, index) => {
        if (['AND', 'OR', 'NOT'].includes(segment)) return

        const operator =
          isSimpleDescription && index > 0 && ['AND', 'OR', 'NOT'].includes(segments[index - 1])
            ? segments[index - 1]
            : 'AND'

        logicalSegments.push({ segment, operator })

        // Dividir el segmento por comas y procesar cada subsegmento
        const subSegments = segment.split(',').map((s) => s.trim())
        results[segment] = results[segment] || new Map<string, number>() // Inicializar el mapa del segmento

        await Promise.all(
          subSegments.map(async (subSegment) => {
            const { matchingTags } = await this.findMatchingTagsForTerm(
              subSegment,
              allTags,
              0.3,
              100,
              true
            )

            // Añadir los resultados de cada subsegmento al mapa del segmento completo
            matchingTags.forEach((tag: any) => {
              const currentProximity = results[segment].get(tag.name) || 0
              results[segment].set(tag.name, Math.max(currentProximity, tag.proximity)) // Usar el mayor proximity
            })

            // Añadir tags únicos al conjunto de tags relevantes
            allRelevantTags = Array.from(
              new Set([...allRelevantTags, ...matchingTags.map((t) => t.name)])
            )
          })
        )
      })
    )

    const totalSegments = logicalSegments.filter(({ operator }) => operator !== 'NOT').length

    const relevantPhotos = photos.filter((photo) => {
      const hasValidTags = photo.tags?.some((tag) => allRelevantTags.includes(tag.name))
      return hasValidTags
    })

    // Calcular puntajes para cada foto
    const scoredPhotos = relevantPhotos.map((photo) => {
      let totalScore = 0
      let matchedSegments = 0
      let hasNotSegmentMatched = false

      if (photo.id == '1f0e706e-9e83-47ce-a553-22123dddf072') {
        console.log()
      }

      // Evaluar cada segmento lógico
      // 1. Si un segmento tiene tag con prox > 0.8, matchea. Si todos los segmentos matchean, la foto va arriba
      // 2. El score de un segmento (usado si no todos matchean), viene dado por el max proximity + suma atenuada (% 2 y capado al max) de proximities
      for (const { segment, operator } of logicalSegments) {
        const tagMap = results[segment]
        const matchingTags = photo.tags?.filter((tag) => tagMap.has(tag.name)) || []

        if (matchingTags.length > 0) {
          const proximities = matchingTags.map((tag) => tagMap.get(tag.name) || 0)
          const maxProximity = Math.max(...proximities)

          const totalProximities = proximities.reduce((sum, proximity) => sum + proximity, 0)
          const adjustedProximities = totalProximities / 2

          if (maxProximity > 0) {
            if (operator == 'OR' || operator == 'AND') matchedSegments++
            if (operator == 'NOT' && !hasNotSegmentMatched) {
              hasNotSegmentMatched = true
            }
          }

          // Calcular la puntuación total sin sobreponderar el maxScore
          totalScore +=
            (maxProximity + Math.min(adjustedProximities, maxProximity)) *
            (operator == 'NOT' ? -0.5 : 1)
        }
      }

      const queryMatched = matchedSegments === totalSegments && !hasNotSegmentMatched
      // El totalScore es 0 cuando un segmento NOT hizo full match
      const totalTagsScore = !hasNotSegmentMatched ? Math.min(totalScore, totalSegments) : 0
      return {
        photo,
        tagScore: queryMatched ? totalSegments + 1 : totalTagsScore,
      }
    })

    const maxScore = Math.max(
      ...scoredPhotos.map(({ tagScore }) => (tagScore > 0 ? tagScore : 0)),
      1
    )

    return scoredPhotos
      .map(({ photo, tagScore }) => ({
        photo,
        tagScore: tagScore > 0 ? tagScore / maxScore : 0, // Normalización
      }))
      .sort((a, b) => {
        if (a.tagScore === 0 && b.tagScore !== 0) return 1
        if (a.tagScore !== 0 && b.tagScore === 0) return -1

        return b.tagScore - a.tagScore // Ordenar por puntaje
      })
      .filter(({ tagScore }) => tagScore > 0) // Excluir fotos penalizadas
  }

  public async findMatchingTagsForTerm(term, tags, embeddingsThreshold, limit) {
    let lematizedTerm = pluralize.singular(term.toLowerCase())
    let termWordCount = lematizedTerm.split(' ').length

    // 1. String comparison con los tags iguales o más cortos
    let equalOrShorterTags = []
    // for (let tag of tags) {
    //   let lematizedTagName = pluralize.singular(tag.name.toLowerCase())
    //   if (lematizedTagName.split(' ').length >= termWordCount) {
    //     equalOrShorterTags.push(tag)
    //   }
    // }

    let matchedTagsByString = equalOrShorterTags
      .map((t) => pluralize.singular(t.name.toLowerCase()))
      .filter((lematizedTagName) => {
        const regex = new RegExp(
          `(^|\\s)${pluralize.singular(lematizedTerm.toLowerCase())}($|\\s)`,
          'i'
        )
        return regex.test(lematizedTagName)
      })

    let stringMatches = matchedTagsByString.map((tagName) => {
      return { name: tagName, proximity: 0.9 }
    })

    // Excluir los tags que ya han sido encontrados por coincidencia de string
    let remainingTags = tags.filter(
      (tag) => !matchedTagsByString.includes(pluralize.singular(tag.name.toLowerCase()))
    )

    // 2. Embeddings + ajuste por inferencia lógica
    let { embeddings } = await this.modelsService.getEmbeddings([term])
    const similarTags = await this.findSimilarTagToEmbedding(
      embeddings[0],
      embeddingsThreshold,
      2000, // debería ser num_photos * constante, con un limite de 5000 o así.
      'cosine_similarity',
      remainingTags.map((t) => t.id) // Solo considerar los tags que no coincidieron por string
    )

    let adjustedSimilarTags = await this.modelsService.adjustProximitiesByContextInference(
      term,
      similarTags,
      'tag'
    )

    let semanticMatches = adjustedSimilarTags.map((tag) => {
      return {
        name: tag.name,
        proximity: tag.proximity,
        embeddingsProximity: tag.embeddingsProximity,
      }
    })

    // Combinar resultados y eliminar duplicados
    let allMatches = [...stringMatches, ...semanticMatches]
    let uniqueMatches = allMatches
      .filter((match, index, self) => index === self.findIndex((t) => t.name === match.name))
      .filter((match) => match.proximity >= 0)

    return {
      matchingTags: uniqueMatches,
      lematizedTerm,
    }
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
