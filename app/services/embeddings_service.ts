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
  photo: Photo
  tagScore?: number // Puntuación por tags
  descScore?: number // Puntuación por embeddings
  totalScore?: number // Puntaje total calculado
}

// interface ChunkedPhoto extends ScoredPhoto {
//   chunks?: { proximity: number; text_chunk: string }[] // Chunks asociados a la foto
// }

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

  public mergeTagDescScoredPhotos(
    aggregatedScores: ScoredPhoto[],
    newScoredTagsPhotos: ScoredPhoto[],
    newScoredDescsPhotos: ScoredPhoto[],
    weights: any
  ): ScoredPhoto[] {
    const map = new Map<number, ScoredPhoto>()

    // Inicia con los scores acumulados previos.
    for (const scored of aggregatedScores) {
      map.set(scored.photo.id, { ...scored })
    }

    // Acumula nuevos scores por tags.
    for (const scored of newScoredTagsPhotos) {
      const id = scored.photo.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.tagScore += scored.tagScore
        entry.totalScore += scored.tagScore * weights.tags
        entry.photo.matchingTags = Array.from(
          new Set([...entry.photo.matchingTags, ...scored.photo.matchingTags])
        )
      } else {
        map.set(id, {
          photo: { ...scored.photo },
          tagScore: scored.tagScore,
          descScore: 0,
          totalScore: scored.tagScore * weights.tags,
        })
      }
    }

    // Acumula nuevos scores por descripción.
    for (const scored of newScoredDescsPhotos) {
      const id = scored.photo.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.descScore += scored.descScore
        entry.totalScore += scored.descScore * weights.desc
        entry.photo.matchingChunks = Array.from(
          new Set([...entry.photo.matchingChunks, ...scored.photo.matchingChunks])
        )
      } else {
        map.set(id, {
          photo: { ...scored.photo },
          tagScore: 0,
          descScore: scored.descScore,
          totalScore: scored.descScore * weights.desc,
        })
      }
    }

    return Array.from(map.values())
  }

  @MeasureExecutionTime
  public async getScoredPhotosByTagsAndDesc(
    photos: Photo[],
    structuredQuery: any,
    searchType: 'logical' | 'semantic' | 'creative',
    quickSearch: boolean = false
  ): Promise<ScoredPhoto[] | undefined> {
    const weights = {
      logical: {
        tags: 1,
        desc: 0,
        fullQuery: 0,
        embeddingsTagsThreshold: quickSearch ? 0.3 : 0.15,
      },
      semantic: {
        tags: quickSearch ? 1 : 0.5,
        desc: quickSearch ? 0 : 0.5,
        fullQuery: quickSearch ? 0 : 0.5,
        embeddingsTagsThreshold: quickSearch ? 0.3 : 0.15,
        embeddingsDescsThreshold: quickSearch ? 0.4 : 0.2,
      },
      creative: {
        tags: quickSearch ? 1 : 0.3,
        desc: quickSearch ? 0 : 0.7,
        fullQuery: quickSearch ? 0 : 0.7,
        embeddingsTagsThreshold: quickSearch ? 0.3 : 0.15,
        embeddingsDescsThreshold: quickSearch ? 0.4 : 0.2,
      },
    }

    let aggregatedScores: ScoredPhoto[] = photos.map((photo) => ({
      photo,
      tagScore: 0,
      descScore: 0,
      totalScore: 0,
      matchedSegments: 0,
    }))

    // Si hay más de un segmento, lanzamos fullQuery en paralelo usando el array original.
    const fullQueryPromise: Promise<ScoredPhoto[]> =
      structuredQuery.positive_segments.length > 1 && weights[searchType].fullQuery > 0
        ? this.getScoredPhotoDescBySegment(
            photos,
            structuredQuery.no_prefix,
            weights[searchType].embeddingsDescsThreshold * 2
          )
        : Promise.resolve([])

    // Procesamos los segmentos secuencialmente en una promesa.
    const segmentsPromise = (async () => {
      let scores = aggregatedScores
      for (const segment of structuredQuery.positive_segments) {
        scores = await this.processSegment(segment, scores, weights[searchType])
      }
      return scores
    })()

    // Esperamos ambas promesas en paralelo.
    const [scoresAfterSegments, fullQueryDescScores] = await Promise.all([
      segmentsPromise,
      fullQueryPromise,
    ])

    // Mergeamos el score fullQuery en los resultados finales.
    const finalScores = this.mergeTagDescScoredPhotos(
      scoresAfterSegments,
      [],
      fullQueryDescScores,
      { tags: 0, desc: weights[searchType].fullQuery }
    )

    return finalScores
      .sort((a, b) => {
        if (b.matchedSegments === a.matchedSegments) return b.totalScore - a.totalScore
        return b.matchedSegments - a.matchedSegments
      })
      .map((score) => ({
        ...score,
        queryMatched: score.matchedSegments == structuredQuery.positive_segments.length,
      }))
  }

  private async processSegment(
    segment: any,
    aggregatedScores: ScoredPhoto[],
    weights: { tags: number; desc: number; fullQuery: number }
  ): Promise<ScoredPhoto[]> {
    const photosToReview = aggregatedScores.map((s) => s.photo)
    const tagPromise =
      weights.tags > 0
        ? this.getScoredPhotoTagsBySegment(photosToReview, segment, weights.embeddingsTagsThreshold)
        : Promise.resolve([])
    const descPromise =
      weights.desc > 0
        ? this.getScoredPhotoDescBySegment(
            photosToReview,
            segment,
            weights.embeddingsDescsThreshold
          )
        : Promise.resolve([])

    const [newTagScores, newDescScores] = await Promise.all([tagPromise, descPromise])

    const matchingSegmentPhotoIds = Array.from(
      new Set([...newTagScores.map((t) => t.photo.id), ...newDescScores.map((t) => t.photo.id)])
    )

    let updatedScores = this.mergeTagDescScoredPhotos(
      aggregatedScores,
      newTagScores,
      newDescScores,
      weights
    )

    updatedScores = updatedScores.map((score) => {
      if (matchingSegmentPhotoIds.includes(score.photo.id)) {
        return { ...score, matchedSegments: score.matchedSegments + 1 } // TODO: matchedSegments incrementa solo con un threshold (conservar en el matchingSegmentPhotoIds)
      }
      return score
    })

    return updatedScores.filter((score) => score.totalScore > 0)
  }

  // TODO: hay que penalizar un poco matcheos negativos
  private async getScoredPhotoDescBySegment(
    photos: Photo[],
    segment: string,
    embeddingsProximityThreshold: number = 0.2
  ): Promise<{ photo: Photo; descScore: number }[]> {
    // Obtener los chunks similares para el segmento
    const matchingChunks = await this.findSimilarChunksToText(
      segment,
      embeddingsProximityThreshold,
      2000,
      'cosine_similarity'
    )

    // Ajustar las proximidades mediante inferencia de contexto
    // < 0 Contradiction
    // == 0 Neutral
    // > 0 Entailment
    const adjustedChunks = await this.modelsService.adjustProximitiesByContextInference(
      segment,
      matchingChunks.map((mc) => ({
        name: mc.chunk,
        proximity: mc.proximity,
        id: mc.id,
      })),
      'desc'
    )

    // Crear un mapa de chunk id a proximidad ajustada
    const chunkMap = new Map<string | number, number>(
      adjustedChunks.map((chunk) => [chunk.id, chunk.proximity])
    )

    // Filtrar las fotos que tienen al menos un chunk relevante
    const relevantPhotos = photos.filter((photo) =>
      photo.descriptionChunks?.some((chunk) => chunkMap.has(chunk.id))
    )

    // Calcular el score para cada foto basado en los chunks coincidentes
    let scoredPhotos = relevantPhotos.map((photo) => {
      photo.matchingChunks = photo.matchingChunks || []
      const matchingPhotoChunks =
        photo.descriptionChunks?.filter((chunk) => chunkMap.has(chunk.id)) || []
      photo.matchingChunks = [
        ...photo.matchingChunks,
        ...matchingPhotoChunks.map((item) => ({
          chunk: item.chunk,
          proximity: chunkMap.get(item.id),
        })),
      ]

      let descScore = 0
      const proximities = matchingPhotoChunks.map((chunk) => chunkMap.get(chunk.id)!)
      const maxProximity = Math.max(...proximities)
      const totalProximities = proximities.reduce((sum, p) => sum + p, 0)
      const adjustedProximity = totalProximities / 2
      descScore = maxProximity + Math.min(adjustedProximity, maxProximity)
      return { photo, descScore }
    })

    // Ordenar de mayor a menor y filtrar según la configuración
    scoredPhotos = scoredPhotos
      .filter((sc) => sc.descScore > 0)
      .sort((a, b) => b.descScore - a.descScore)
    return scoredPhotos
  }

  private async getScoredPhotoTagsBySegment(
    photos: Photo[],
    segment: string,
    embeddingsProximityThreshold: number = 0.15
  ): Promise<{ photo: Photo; tagScore: number }[]> {
    const allTags = await Tag.all()

    // Obtenemos los matching tags directamente del segmento
    const { matchingTags } = await this.findMatchingTagsForTerm(
      segment,
      allTags,
      embeddingsProximityThreshold
    )
    const tagMap = new Map<string, number>()
    matchingTags.forEach((tag: any) => {
      const current = tagMap.get(tag.name) || 0
      tagMap.set(tag.name, Math.max(current, tag.proximity))
    })

    // Calcular el score para cada foto basándonos en los tags coincidentes
    let scoredPhotos = photos.map((photo) => {
      photo.matchingTags = photo.matchingTags || []
      const matchingPhotoTags = photo.tags?.filter((tag) => tagMap.has(tag.name)) || []
      photo.matchingTags = [...photo.matchingTags, ...matchingPhotoTags.map((tag) => tag.name)]
      let tagScore = 0
      if (matchingPhotoTags.length > 0) {
        const proximities = matchingPhotoTags.map((tag) => tagMap.get(tag.name)!)
        const maxProximity = Math.max(...proximities)
        const totalProximities = proximities.reduce((sum, p) => sum + p, 0)
        const adjustedProximity = totalProximities / 2
        tagScore = maxProximity + Math.min(adjustedProximity, maxProximity)
      }
      return { photo, tagScore }
    })

    // Ordenamos y filtramos según la lógica aplicada
    scoredPhotos = scoredPhotos
      .filter((sc) => sc.tagScore > 0)
      .sort((a, b) => b.tagScore - a.tagScore)
    return scoredPhotos
  }

  public async findMatchingTagsForTerm(term, tags, embeddingsProximityThreshold: number) {
    let lematizedTerm = pluralize.singular(term.toLowerCase())
    let termWordCount = lematizedTerm.split(' ').length

    let lematizedTagNames = []
    for (let tag of tags) {
      let lematizedTagName = pluralize.singular(tag.name.toLowerCase())
      lematizedTagNames.push({ name: lematizedTagName, id: tag.id })
    }

    // 1. String comparison con los tags iguales o más cortos
    let equalOrShorterTags = []
    for (let tag of lematizedTagNames) {
      if (tag.name.split(' ').length >= termWordCount) {
        equalOrShorterTags.push(tag)
      }
    }

    let matchedTagsByString = equalOrShorterTags.filter((tag) => {
      const regex = new RegExp(`(^|\\s)${lematizedTerm}($|\\s)`, 'i')
      return regex.test(tag.name)
    })

    let stringMatches = matchedTagsByString.map((tag) => {
      return { name: tags.find((t) => t.id == tag.id).name, proximity: 0.9 }
    })

    // Excluir los tags que ya han sido encontrados por coincidencia de string
    let remainingTags = lematizedTagNames.filter((tag) => !matchedTagsByString.includes(tag.name))

    // 2. Embeddings + ajuste por inferencia lógica
    let { embeddings } = await this.modelsService.getEmbeddings([lematizedTerm])
    const similarTags = await this.findSimilarTagToEmbedding(
      embeddings[0],
      embeddingsProximityThreshold,
      1500, // debería ser num_photos * constante, con un limite de 5000 o así.
      'cosine_similarity',
      remainingTags.map((t) => t.id) // Solo considerar los tags que no coincidieron por string
    )

    // < 0 Contradiction
    // == 0 Neutral
    // > 0 Entailment
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
      .filter((match) => match.proximity > 0)

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
