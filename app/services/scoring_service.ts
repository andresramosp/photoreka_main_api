// @ts-nocheck

import Tag from '#models/tag'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
import VectorService from './vector_service.js'
import { withCache } from '../decorators/withCache.js'
import type { SearchMode, SearchType } from './search_text_service.js'
import TagPhotoManager from '../managers/tag_photo_manager.js'
import TagManager from '../managers/tag_manager.js'
import TagPhoto from '#models/tag_photo'
import { EmbeddingStoreService } from './embeddings_store_service.js'
import NLPService from './nlp_service.js'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const cache = new NodeCache({ stdTTL: 3600 })

interface ScoredPhoto {
  id: number
  tagScore?: number
  descScore?: number
  totalScore?: number
  matchingTags?: any[]
  matchingChunks?: any[]
}

// Interfaces para sistema de puntuación absoluta

interface MatchThresholds {
  excellent: number // 90-100%
  good: number // 70-89%
  fair: number // 50-69%
  poor: number // 30-49%
}

interface SearchComposition {
  hasFullQuery: boolean
  hasNuances: boolean
  segmentCount: number
  searchMode?: SearchMode
}

const MAX_SIMILAR_TAGS = 1250
const MAX_SIMILAR_CHUNKS = 850

const getWeights = (isCuration: boolean) => {
  return {
    tags: {
      tags: true,
      desc: false,
      fullQuery: false,
      embeddingsTagsThreshold: 0.15,
    },
    semantic: {
      tags: true, //isCuration ? false : true,
      desc: true, //isCuration ? true : true,
      fullQuery: true,
      embeddingsTagsThreshold: 0.13,
      embeddingsDescsThreshold: 0.17,
      embeddingsFullQueryThreshold: 0.3,
    },
    topological: {
      tags: true,
      desc: false,
      fullQuery: false,
      embeddingsTagsThreshold: 0.13,
    },
    nuancesTags: {
      tags: true,
      desc: false,
      fullQuery: false,
      embeddingsTagsThreshold: 0.35,
    },
  }
}

export default class ScoringService {
  public modelsService: ModelsService = null
  public vectorService: VectorService = null
  public tagManager: TagManager = null
  public tagPhotoManager: TagPhotoManager = null
  public nlpService: NLPService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.vectorService = new VectorService()
    this.tagManager = new TagManager()
    this.tagPhotoManager = new TagPhotoManager()
    this.nlpService = new NLPService()
  }

  // Métodos para sistema de puntuación absoluta
  private analyzeSearchComposition(
    structuredQuery: any,
    weights: any,
    searchType: string,
    searchMode?: SearchMode
  ): SearchComposition {
    const typeWeights = weights[searchType] || weights.semantic

    return {
      hasFullQuery:
        structuredQuery.positive_segments.length > 1 &&
        (typeWeights.fullQuery || searchType === 'semantic'),
      hasNuances: structuredQuery.nuances_segments?.length > 0,
      segmentCount: structuredQuery.positive_segments.length,
      searchMode,
    }
  }

  private getAbsoluteThresholds(composition: SearchComposition): MatchThresholds {
    // Modificador para umbrales menos estrictos (configurable)
    const THRESHOLD_MODIFIER_NON_LOGICAL = 0.7
    // Umbrales base normalizados por segmento
    let segmentCount = Math.max(1, composition.segmentCount)
    // Si hay fullQuery, cuenta como 1/4 segmento adicional
    // Es decir, el score maximo es mas exigente
    if (composition.hasFullQuery) {
      segmentCount += 0.25
    }

    // Modificador para searchMode distinto de 'logical'
    const thresholdModifier =
      composition.searchMode !== 'logical' ? THRESHOLD_MODIFIER_NON_LOGICAL : 1

    // Cada umbral es un porcentaje del máximo posible (segmentCount)
    // El rango total será de 0 a segmentCount
    const base = {
      excellent: 0.9 * segmentCount * thresholdModifier, // 90-100%
      good: 0.7 * segmentCount * thresholdModifier, // 70-89%
      fair: 0.5 * segmentCount * thresholdModifier, // 50-69%
      poor: 0.3 * segmentCount * thresholdModifier, // 30-49%
    }

    return base
  }

  private getLabelScore(totalScore: number, thresholds: MatchThresholds): number {
    if (totalScore >= thresholds.excellent) {
      return 'excellent'
    } else if (totalScore >= thresholds.good) {
      return 'good'
    } else if (totalScore >= thresholds.fair) {
      return 'fair'
    } else {
      return 'poor'
    }
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 5,
  })
  public async getScoredPhotosByTagsAndDesc(
    photoIds: number[],
    structuredQuery: any,
    searchMode: SearchMode,
    userId: string
  ): Promise<ScoredPhoto[] | undefined> {
    let weights = getWeights(searchMode == 'curation')

    structuredQuery.positive_segments = this.nlpService.normalizeTerms(
      structuredQuery.positive_segments
    )

    if (structuredQuery.nuances_segments.length)
      structuredQuery.nuances_segments = this.nlpService.normalizeTerms(
        structuredQuery.nuances_segments
      )

    await EmbeddingStoreService.calculateEmbeddings(
      [
        ...structuredQuery.positive_segments,
        ...structuredQuery.nuances_segments,
        structuredQuery.no_prefix,
      ].filter(Boolean),
      true
    )

    // Inicializamos solo IDs, no objetos completos
    let aggregatedScores: ScoredPhoto[] = photoIds.map((id) => ({
      id,
      tagScore: 0,
      descScore: 0,
      totalScore: 0,
    }))

    const performFullQuerySearch = structuredQuery.positive_segments.length > 1

    const fullQueryPromise: Promise<ScoredPhoto[]> = performFullQuerySearch
      ? this.getScoredPhotoDescBySegment(
          photoIds,
          { name: structuredQuery.no_prefix, index: -1 },
          weights.semantic.embeddingsFullQueryThreshold,
          searchMode,
          true,
          ['context', 'story', 'visual_accents']
        )
      : Promise.resolve([])

    const performNuancesQuerySearch =
      structuredQuery.nuances_segments?.length > 0 && searchMode == 'curation'

    const nuancesQuery: Promise<ScoredPhoto[]> = performNuancesQuerySearch
      ? Promise.all(
          structuredQuery.nuances_segments.map((nuance_segment, index) =>
            this.processSegment(
              { name: nuance_segment, index },
              aggregatedScores,
              weights.nuancesTags,
              searchMode,
              structuredQuery.include_visual_aspects
                ? ['context_story', 'visual_accents', 'visual_aspects']
                : ['context_story', 'visual_accents'],
              ['context', 'story', 'visual_accents'],
              [],
              userId
            )
          )
        )
      : Promise.resolve([])

    const segmentsPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, segment] of structuredQuery.positive_segments.entries()) {
        scores = await this.processSegment(
          { name: segment, index },
          scores,
          weights.semantic,
          searchMode,
          structuredQuery.include_visual_aspects
            ? ['context_story', 'visual_accents', 'visual_aspects']
            : ['context_story', 'visual_accents'],
          ['context', 'story'],
          [],
          userId
        )
      }
      return scores
    })()

    const [scoresAfterSegments, fullQueryDescScores, nuancesQueryTagsScore] = await Promise.all([
      segmentsPromise,
      fullQueryPromise,
      nuancesQuery,
    ])

    let finalScores = this.mergeTagDescScoredPhotos(scoresAfterSegments, [], fullQueryDescScores)

    for (let nuanceTagScore of nuancesQueryTagsScore) {
      finalScores = this.mergeTagDescScoredPhotos(finalScores, nuanceTagScore, [])
    }

    // Nuevo sistema de scoring absoluto
    const searchComposition = this.analyzeSearchComposition(
      structuredQuery,
      weights,
      'semantic',
      searchMode
    )
    const thresholds = this.getAbsoluteThresholds(searchComposition)

    const filteredSortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        labelScore: this.getLabelScore(score.totalScore, thresholds),
      }))
    //.filter((score) => score.labelScore >= 10) // Opcional: filtrar resultados no relevantes

    return filteredSortedScores
  }

  // TODO: replantear: tiene
  private async filterExcludedPhotoIdsByTags(
    photoIds: number[],
    excluded: string[],
    searchMode: SearchMode,
    userId: string
  ): Promise<number[]> {
    const proximityThreshold = 0.4
    const allTags = await this.tagManager.getTagsByUser(userId)

    const matchingPromises = excluded.map((tag) =>
      this.findMatchingTagsForSegment(
        { name: tag, index: 1 },
        allTags,
        0.2,
        searchMode,
        photoIds,
        [],
        []
      )
    )

    const matchingResults = await Promise.all(matchingPromises)
    const allExcludedTags = matchingResults.map((mr) => mr.matchingPhotoTags).flat()
    const excludedTagNames = allExcludedTags
      .filter((t) => t.proximity > proximityThreshold)
      .map((t) => t.name)

    console.log(`Excluded: ${excludedTagNames}`)

    // Ahora consultamos solo los IDs que tengan esos tags
    const photosWithExcludedTags = await Photo.query()
      .whereIn('id', photoIds)
      .whereHas('tags', (query) => {
        query.whereHas('tag', (tagQuery) => {
          tagQuery.whereIn('name', excludedTagNames)
        })
      })
      .select('id')

    const excludedPhotoIds = photosWithExcludedTags.map((p) => p.id)

    // Devolvemos solo los IDs que no están excluidos
    return photoIds.filter((id) => !excludedPhotoIds.includes(id))
  }

  // TODO: userid!!
  // @withCache({
  //   provider: 'redis',
  //   ttl: 120,
  // })
  public async getScoredPhotosByTags(
    photoIds: number[],
    included: string[],
    excluded: string[],
    searchMode: SearchMode,
    userId: string
  ): Promise<ScoredPhoto[] | undefined> {
    const weights = getWeights(searchMode == 'curation')

    included = this.nlpService.normalizeTerms(included)
    excluded = this.nlpService.normalizeTerms(excluded)

    await EmbeddingStoreService.calculateEmbeddings([...included, ...excluded])

    // Aplicar exclusión directamente a nivel de IDs
    const filteredPhotoIds = await this.filterExcludedPhotoIdsByTags(
      photoIds,
      excluded,
      searchMode,
      userId
    )

    let aggregatedScores: ScoredPhoto[] = filteredPhotoIds.map((id) => ({
      id,
      tagScore: 0,
      descScore: 0,
      totalScore: 0.0001, // Para que devuelva algo si solo hay negativos, sin afectar al score
    }))

    const includedPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, segment] of included.entries()) {
        scores = await this.processSegment(
          { name: segment, index },
          scores,
          weights.tags,
          searchMode,
          ['context_story', 'visual_accents', 'visual_aspects'],
          ['context', 'story'],
          [],
          userId
        )
      }
      return scores
    })()

    const [finalScores] = await Promise.all([includedPromise])

    // Nuevo sistema de scoring absoluto para tags
    const tagQueryStructure = {
      positive_segments: included,
      nuances_segments: [],
    }
    const searchComposition = this.analyzeSearchComposition(tagQueryStructure, weights, 'tags')
    const thresholds = this.getAbsoluteThresholds(searchComposition)

    const sortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        labelScore: this.getLabelScore(score.totalScore, thresholds),
      }))

    return sortedScores
  }

  // TODO: cache
  // TODO: Probar solo excluir area contraria
  public async getScoredPhotosByTopoAreas(
    photoIds: number[],
    queryByAreas: { left: string; right: string; middle: string },
    searchMode: SearchMode,
    userId: string
  ): Promise<ScoredPhoto[] | undefined> {
    const weights = getWeights(searchMode == 'curation')

    queryByAreas.left = !!queryByAreas.left
      ? this.nlpService.normalizeTerms([queryByAreas.left])[0]
      : null
    queryByAreas.right = !!queryByAreas.right
      ? this.nlpService.normalizeTerms([queryByAreas.right])[0]
      : null
    queryByAreas.middle = !!queryByAreas.middle
      ? this.nlpService.normalizeTerms([queryByAreas.middle])[0]
      : null

    await EmbeddingStoreService.calculateEmbeddings(
      [queryByAreas.left, queryByAreas.right, queryByAreas.middle].filter(Boolean)
    )

    let aggregatedScores: ScoredPhoto[] = photoIds.map((id) => ({
      id,
      descScore: 0,
      tagScore: 0,
      totalScore: 0.0001,
      matchingTags: [],
      matchingChunks: [],
    }))

    const oppositeAreas: { [key: string]: string } = {
      left: 'right',
      right: 'left',
    }

    const filledAreas = Object.entries(queryByAreas)
      .filter(([_, value]) => value?.trim())
      .map(([area, content]) => ({ area, content }))

    const includedPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, { area, content }] of filledAreas.entries()) {
        const areasToSearch = [area]
        scores = await this.processSegment(
          { name: content, index },
          scores,
          weights.topological,
          searchMode,
          ['context_story', 'visual_accents'],
          [],
          areasToSearch,
          userId
        )
      }
      return scores
    })()

    const [finalScores] = await Promise.all([includedPromise])

    // Nuevo sistema de scoring absoluto para topológico
    const topoQueryStructure = {
      positive_segments: filledAreas.map((a) => a.content),
      nuances_segments: [],
    }
    const searchComposition = this.analyzeSearchComposition(
      topoQueryStructure,
      weights,
      'topological'
    )
    const thresholds = this.getAbsoluteThresholds(searchComposition)

    const sortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        labelScore: this.getLabelScore(score.totalScore, thresholds),
      }))

    const photoModels = await Photo.query().whereIn(
      'id',
      sortedScores.map((s) => s.id)
    )

    const photoMap = new Map(photoModels.map((p) => [p.id, p]))

    return sortedScores.map((score) => ({
      ...score,
      photo: photoMap.get(score.id),
    }))
  }

  private mergeTagDescScoredPhotos(
    aggregatedScores: ScoredPhoto[],
    newScoredTagsPhotos: { id: number; tagScore: number; matchingTags?: any[] }[],
    newScoredDescsPhotos: { id: number; descScore: number; matchingChunks?: any[] }[]
  ): ScoredPhoto[] {
    const map = new Map<number, ScoredPhoto>()

    // Inicia con los scores acumulados previos.
    for (const scored of aggregatedScores) {
      map.set(scored.id, { ...scored })
    }

    // Calcular el score del segmento actual para cada foto
    const segmentScores = new Map<number, number>()

    // Recopilar scores de tags para este segmento
    for (const scored of newScoredTagsPhotos) {
      const currentScore = segmentScores.get(scored.id) || 0
      segmentScores.set(scored.id, Math.max(currentScore, scored.tagScore))
    }

    // Recopilar scores de descriptions para este segmento
    for (const scored of newScoredDescsPhotos) {
      const currentScore = segmentScores.get(scored.id) || 0
      segmentScores.set(scored.id, Math.max(currentScore, scored.descScore))
    }

    // Actualizar o crear entradas con matching tags/chunks
    for (const scored of newScoredTagsPhotos) {
      const id = scored.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.tagScore = Math.max(entry.tagScore || 0, scored.tagScore)
        entry.matchingTags = Array.from(
          new Set([...(entry.matchingTags || []), ...(scored.matchingTags || [])])
        )
      } else {
        map.set(id, {
          id,
          tagScore: scored.tagScore,
          descScore: 0,
          totalScore: 0,
          matchingTags: scored.matchingTags || [],
          matchingChunks: [],
        })
      }
    }

    for (const scored of newScoredDescsPhotos) {
      const id = scored.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.descScore = Math.max(entry.descScore || 0, scored.descScore)
        entry.matchingChunks = Array.from(
          new Set([...(entry.matchingChunks || []), ...(scored.matchingChunks || [])])
        )
      } else {
        map.set(id, {
          id,
          tagScore: 0,
          descScore: scored.descScore,
          totalScore: 0,
          matchingTags: [],
          matchingChunks: scored.matchingChunks || [],
        })
      }
    }

    // Sumar el score del segmento actual al totalScore acumulado
    for (const [photoId, segmentScore] of segmentScores) {
      if (map.has(photoId)) {
        const entry = map.get(photoId)!
        entry.totalScore = (entry.totalScore || 0) + segmentScore
      }
    }

    return Array.from(map.values())
  }

  private async processSegment(
    segment: { name: string; index: number },
    aggregatedScores: ScoredPhoto[],
    weights: { tags: boolean; desc: boolean; fullQuery: boolean | null },
    searchMode: SearchMode,
    tagsCategories: string[],
    descCategories: string[],
    areas: string[],
    userId: string
  ): Promise<ScoredPhoto[]> {
    const photoIds = aggregatedScores.map((s) => s.id)

    const tagPromise =
      weights.tags && photoIds.length
        ? this.getScoredPhotoTagsBySegment(
            photoIds,
            segment,
            weights.embeddingsTagsThreshold,
            searchMode,
            tagsCategories,
            areas,
            userId
          )
        : Promise.resolve([])

    const descPromise =
      weights.desc && photoIds.length
        ? this.getScoredPhotoDescBySegment(
            photoIds,
            segment,
            weights.embeddingsDescsThreshold,
            searchMode,
            false,
            descCategories,
            areas
          )
        : Promise.resolve([])

    const [newTagScores, newDescScores] = await Promise.all([tagPromise, descPromise])

    const matchingSegmentPhotoIds = new Set([
      ...newTagScores.map((t) => t.id),
      ...newDescScores.map((d) => d.id),
    ])

    let updatedScores = this.mergeTagDescScoredPhotos(aggregatedScores, newTagScores, newDescScores)

    return updatedScores.filter((score) => matchingSegmentPhotoIds.has(score.id))
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 30,
  })
  private async getScoredPhotoDescBySegment(
    photoIds: number[],
    segment: { name: string; index: number },
    embeddingsProximityThreshold: number = 0.2,
    searchMode: SearchMode,
    isFullQuery: boolean = false,
    categories: string[],
    areas: string[]
  ): Promise<{ id: number; descScore: number; matchingChunks: any[] }[]> {
    const embedding = EmbeddingStoreService.getEmbedding(segment.name)

    const matchingChunks = await this.vectorService.findSimilarChunkToEmbedding(
      embedding,
      embeddingsProximityThreshold,
      MAX_SIMILAR_CHUNKS,
      'cosine_similarity',
      photoIds,
      categories,
      areas
    )

    let adjustedChunks = await this.adjustProximities(
      segment.name,
      matchingChunks.map((mc) => ({
        name: mc.chunk.replace(/\.$/, ''),
        proximity: mc.proximity,
        chunk_id: mc.id,
        photo_id: mc.photo_id, // asegurarte que viene incluido desde vectorService
      })),
      'desc',
      searchMode
    )

    const photoChunkMap = new Map<number, any[]>()
    for (const chunk of adjustedChunks) {
      if (!photoChunkMap.has(chunk.photo_id)) {
        photoChunkMap.set(chunk.photo_id, [])
      }
      if (chunk.proximity > 0) {
        photoChunkMap.get(chunk.photo_id).push({
          chunk: chunk.name,
          proximity: chunk.proximity,
          isFullQuery,
        })
      }
    }

    const scoredPhotos = Array.from(photoChunkMap.entries()).map(([photoId, matchingChunks]) => {
      const proximities = matchingChunks.map((c) => c.proximity)
      const descScore = Math.max(...proximities)

      return {
        id: photoId,
        descScore,
        matchingChunks,
      }
    })

    return scoredPhotos
      .filter((score) => score.descScore > 0)
      .sort((a, b) => b.descScore - a.descScore)
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 30,
  })
  private async getScoredPhotoTagsBySegment(
    photoIds: number[],
    segment: { name: string; index: number },
    embeddingsProximityThreshold: number = 0.15,
    searchMode: SearchMode,
    categories?: string[],
    areas: string[],
    userId: string
  ): Promise<{ id: number; tagScore: number; matchingTags: any[] }[]> {
    let userTags = await this.tagManager.getTagsByUser(userId)

    const { matchingPhotoTags } = await this.findMatchingTagsForSegment(
      segment,
      userTags,
      embeddingsProximityThreshold,
      searchMode,
      photoIds,
      categories,
      areas
    )

    const photoTagMap = new Map<number, any[]>()

    for (const pt of matchingPhotoTags) {
      if (!categories || categories.includes(pt.category)) {
        if (!photoTagMap.has(pt.photo_id)) {
          photoTagMap.set(pt.photo_id, [])
        }
        photoTagMap.get(pt.photo_id).push({
          name: pt.name,
          proximity: pt.proximity,
        })
      }
    }

    const scoredPhotos = Array.from(photoTagMap.entries()).map(([photoId, matchingTags]) => {
      const proximities = matchingTags.map((t) => t.proximity)
      const tagScore = Math.max(...proximities)

      return {
        id: photoId,
        tagScore,
        matchingTags,
      }
    })

    return scoredPhotos
      .filter((score) => score.tagScore > 0)
      .sort((a, b) => b.tagScore - a.tagScore)
  }

  public async findMatchingTagsForSegment(
    segment: { name: string; index: number },
    userTags,
    embeddingsProximityThreshold: number,
    searchMode: SearchMode,
    photoIds: number[],
    categories: string[],
    areas: string[]
  ) {
    // 1) Comparación por cadenas

    // TODO: rehacer para que funcione con tag_photo y solo si no hay areas!!
    // let { lematizedTerm, stringMatches, remainingTags } = this.getStringMatches(segment, userTags)

    // 2) Comparación y ajuste semántico/lógico
    const semanticMatches = await this.getSemanticMatches(
      segment.name,
      userTags,
      embeddingsProximityThreshold,
      photoIds,
      categories,
      areas,
      searchMode
    )

    // Combinar y filtrar duplicados
    // const allMatches = [...stringMatches, ...semanticMatches]
    const allMatches = [...semanticMatches]

    return { matchingPhotoTags: allMatches }
  }

  private getStringMatches(segment: { name: string; index: number }, userTags) {
    const lematizedTerm = pluralize.singular(segment.name.toLowerCase())
    const termWordCount = lematizedTerm.split(' ').length

    const lematizedTagNames = userTags.map((tag) => ({
      name: pluralize.singular(tag.name.toLowerCase()),
      id: tag.id,
    }))

    // Filtrar tags con igual o mayor cantidad de palabras que el término
    const equalOrShorterTags = lematizedTagNames.filter(
      (tag) => tag.name.split(' ').length >= termWordCount
    )

    // Coincidencia por expresión regular
    const regex = new RegExp(`(^|\\s)${lematizedTerm}($|\\s)`, 'i')
    const matchedTagsByString = equalOrShorterTags.filter((tag) => regex.test(tag.name))
    const stringMatches = matchedTagsByString.map((tag) => ({
      id: tag.id,
      name: userTags.find((t) => t.id === tag.id).name,
      proximity: 1.9,
    }))

    // Excluir tags ya coincidentes por string
    const remainingTags = lematizedTagNames.filter(
      (tag) => !matchedTagsByString.some((matchedTag) => matchedTag.name === tag.name)
    )

    return { lematizedTerm, stringMatches, remainingTags }
  }

  private async getSemanticMatches(
    term: string,
    userTags,
    embeddingsProximityThreshold: number,
    photoIds: number[],
    categories: string[],
    areas: string[],
    searchMode: SearchMode
  ) {
    const embedding = EmbeddingStoreService.getEmbedding(term)

    // Buscar similitud
    const similarTags = await this.vectorService.findSimilarTagToEmbedding(
      embedding,
      embeddingsProximityThreshold,
      MAX_SIMILAR_TAGS,
      'cosine_similarity',
      userTags.map((t) => t.id),
      categories,
      areas,
      photoIds
    )

    // Ajustar proximidades según inferencia lógica
    const adjustedSimilarTags = await this.adjustProximities(term, similarTags, 'tag', searchMode)

    return adjustedSimilarTags
  }

  public async adjustProximities(term, tags, termsType = 'tag', searchMode: SearchMode) {
    let result

    const LOGIC_THRESHOLD = 1.5
    // Low precision
    if (searchMode == 'low_precision') {
      return tags.filter((tag) => tag.proximity > 0)
    }

    const adjustedProximitiesByContext =
      await this.modelsService.adjustProximitiesByContextInference(term, tags, termsType, false)

    // Logical
    if (searchMode == 'logical') {
      result = adjustedProximitiesByContext
        .map((ap) => ({
          ...ap,
          proximity: ap.logicProximity,
        }))
        .filter((element) => element.proximity > LOGIC_THRESHOLD)
        .map((element) => ({
          ...element,
          proximity: (element.proximity - LOGIC_THRESHOLD) / (2 - LOGIC_THRESHOLD),
        }))
      return result
      // Flexible
    } else {
      const maxPossible = 1 + Math.log1p(2) // embeddingsProximity max 1, logicProximity max 2
      result = adjustedProximitiesByContext
        .map((ap) => {
          const logicBonus = Math.max(ap.logicProximity, 0)
          const scaledBonus = Math.log1p(logicBonus)
          const rawProximity = ap.embeddingsProximity + scaledBonus
          return {
            ...ap,
            rawProximity,
          }
        })
        .filter((element) => element.rawProximity > 0.9)
        .map((element) => {
          const normalizedProximity = Math.max(0, Math.min(1, element.rawProximity / maxPossible))
          return {
            ...element,
            proximity: normalizedProximity,
          }
        })
      return result
    }
  }
}
