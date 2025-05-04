// @ts-nocheck

import Tag from '#models/tag'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
import EmbeddingsService from './embeddings_service.js'
import { withCache } from '../decorators/withCache.js'
import type { SearchMode, SearchType } from './search_text_service.js'
import TagPhotoManager from '../managers/tag_photo_manager.js'
import TagManager from '../managers/tag_manager.js'
import TagPhoto from '#models/tag_photo'
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

const MAX_SIMILAR_TAGS = 1250
const MAX_SIMILAR_CHUNKS = 850

const getWeights = (isCreative: boolean) => {
  return {
    tags: {
      tags: 1,
      desc: 0,
      fullQuery: null,
      embeddingsTagsThreshold: 0.15,
    },
    semantic: {
      tags: isCreative ? 0 : 0.4,
      desc: isCreative ? 1 : 0.6,
      fullQuery: 2,
      embeddingsTagsThreshold: 0.13,
      embeddingsDescsThreshold: 0.17,
      embeddingsFullQueryThreshold: 0.3,
    },
    topological: {
      tags: 1,
      desc: 0,
      fullQuery: 0,
      embeddingsTagsThreshold: 0.13,
    },
    nuancesTags: {
      tags: 1,
      desc: 0,
      fullQuery: null,
      embeddingsTagsThreshold: 0.35,
    },
  }
}

export default class ScoringService {
  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public tagManager: TagManager = null
  public tagPhotoManager: TagPhotoManager = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.tagManager = new TagManager()
    this.tagPhotoManager = new TagPhotoManager()
  }

  // @MeasureExecutionTime
  // TODO: userid!!
  @withCache({
    provider: 'redis',
    ttl: 60 * 5,
  })
  public async getScoredPhotosByTagsAndDesc(
    photoIds: number[],
    structuredQuery: any,
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    let weights = getWeights(searchMode == 'creative')

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
      structuredQuery.nuances_segments?.length > 0 && searchMode == 'creative'

    const nuancesQuery: Promise<ScoredPhoto[]> = performNuancesQuerySearch
      ? Promise.all(
          structuredQuery.nuances_segments.map((nuance_segment, index) =>
            this.processSegment(
              { name: nuance_segment, index },
              aggregatedScores,
              weights.nuancesTags,
              searchMode,
              ['context_story', 'visual_accents'],
              ['context', 'story', 'visual_accents']
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
          ['context_story', 'visual_accents'],
          ['context', 'story']
        )
      }
      return scores
    })()

    const [scoresAfterSegments, fullQueryDescScores, nuancesQueryTagsScore] = await Promise.all([
      segmentsPromise,
      fullQueryPromise,
      nuancesQuery,
    ])

    let finalScores = this.mergeTagDescScoredPhotos(scoresAfterSegments, [], fullQueryDescScores, {
      tags: 0,
      desc: weights.semantic.fullQuery,
    })

    for (let nuanceTagScore of nuancesQueryTagsScore) {
      finalScores = this.mergeTagDescScoredPhotos(finalScores, nuanceTagScore, [], {
        tags: 1,
        desc: 0,
      })
    }

    let potentialMaxScore = this.getMaxPotentialScore(structuredQuery, 'semantic', weights)

    const filteredSortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
      }))

    return filteredSortedScores
  }

  // TODO: replantear: tiene
  private async filterExcludedPhotoIdsByTags(
    photoIds: number[],
    excluded: string[]
  ): Promise<number[]> {
    const proximityThreshold = 1 + 0.6
    const allTags = await this.tagManager.getTagsByUser('1234')

    const matchingPromises = excluded.map((tag) =>
      this.findMatchingTagsForSegment({ name: tag, index: 1 }, allTags, 0.2, true, photoIds)
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
  @withCache({
    provider: 'redis',
    ttl: 120,
  })
  public async getScoredPhotosByTags(
    photoIds: number[],
    included: string[],
    excluded: string[],
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    const weights = getWeights(searchMode == 'creative')

    // Aplicar exclusión directamente a nivel de IDs
    const filteredPhotoIds = await this.filterExcludedPhotoIdsByTags(photoIds, excluded)

    let aggregatedScores: ScoredPhoto[] = filteredPhotoIds.map((id) => ({
      id,
      tagScore: 0,
      descScore: 0,
      totalScore: 1, // Para que devuelva algo si solo hay negativos
    }))

    const includedPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, segment] of included.entries()) {
        scores = await this.processSegment(
          { name: segment, index },
          scores,
          weights.tags,
          searchMode,
          ['context_story', 'visual_accents'],
          ['context', 'story']
        )
      }
      return scores
    })()

    const [finalScores] = await Promise.all([includedPromise])

    const potentialMaxScore = 10 // O ajusta usando this.getMaxPotentialScore si lo prefieres

    const sortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
      }))

    return sortedScores
  }

  // TODO: cache
  // TODO: Probar solo excluir area contraria
  public async getScoredPhotosByTopoAreas(
    photoIds: number[],
    queryByAreas: { left: string; right: string; middle: string },
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    const weights = getWeights(searchMode == 'creative')

    let aggregatedScores: ScoredPhoto[] = photoIds.map((id) => ({
      id,
      descScore: 0,
      tagScore: 0,
      totalScore: 1,
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
          areasToSearch
        )
      }
      return scores
    })()

    const [finalScores] = await Promise.all([includedPromise])
    const potentialMaxScore = 10

    const sortedScores = finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
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
    newScoredDescsPhotos: { id: number; descScore: number; matchingChunks?: any[] }[],
    weights: any
  ): ScoredPhoto[] {
    const map = new Map<number, ScoredPhoto>()

    // Inicia con los scores acumulados previos.
    for (const scored of aggregatedScores) {
      map.set(scored.id, { ...scored })
    }

    // Acumula nuevos scores por tags.
    for (const scored of newScoredTagsPhotos) {
      const id = scored.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.tagScore = (entry.tagScore || 0) + scored.tagScore
        entry.totalScore = (entry.totalScore || 0) + scored.tagScore * weights.tags
        entry.matchingTags = Array.from(
          new Set([...(entry.matchingTags || []), ...(scored.matchingTags || [])])
        )
      } else {
        map.set(id, {
          id,
          tagScore: scored.tagScore,
          descScore: 0,
          totalScore: scored.tagScore * weights.tags,
          matchingTags: scored.matchingTags || [],
          matchingChunks: [],
        })
      }
    }

    // Acumula nuevos scores por descripción.
    for (const scored of newScoredDescsPhotos) {
      const id = scored.id
      if (map.has(id)) {
        const entry = map.get(id)!
        entry.descScore = (entry.descScore || 0) + scored.descScore
        entry.totalScore = (entry.totalScore || 0) + scored.descScore * weights.desc
        entry.matchingChunks = Array.from(
          new Set([...(entry.matchingChunks || []), ...(scored.matchingChunks || [])])
        )
      } else {
        map.set(id, {
          id,
          tagScore: 0,
          descScore: scored.descScore,
          totalScore: scored.descScore * weights.desc,
          matchingTags: [],
          matchingChunks: scored.matchingChunks || [],
        })
      }
    }

    return Array.from(map.values())
  }

  private async processSegment(
    segment: { name: string; index: number },
    aggregatedScores: ScoredPhoto[],
    weights: { tags: number; desc: number; fullQuery: number },
    searchMode: SearchMode,
    tagsCategories: string[],
    descCategories: string[],
    areas: string[]
  ): Promise<ScoredPhoto[]> {
    const photoIds = aggregatedScores.map((s) => s.id)

    const tagPromise =
      weights.tags > 0 && photoIds.length
        ? this.getScoredPhotoTagsBySegment(
            photoIds,
            segment,
            weights.embeddingsTagsThreshold,
            searchMode,
            tagsCategories,
            areas
          )
        : Promise.resolve([])

    const descPromise =
      weights.desc > 0 && photoIds.length
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

    let updatedScores = this.mergeTagDescScoredPhotos(
      aggregatedScores,
      newTagScores,
      newDescScores,
      weights
    )

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
    const numberOfWords = segment.name.split(' ').length
    const term = numberOfWords < 2 ? pluralize.singular(segment.name.toLowerCase()) : segment.name

    const matchingChunks = await this.embeddingsService.findSimilarChunksToText(
      term,
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
        photo_id: mc.photo_id, // asegurarte que viene incluido desde embeddingsService
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
      const descScore = this.calculateProximitiesScores(proximities)
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
    areas: string[]
  ): Promise<{ id: number; tagScore: number; matchingTags: any[] }[]> {
    let userTags = await this.tagManager.getTagsByUser('1234')

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
      const tagScore = this.calculateProximitiesScores(proximities)
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
    let { lematizedTerm, stringMatches, remainingTags } = this.getStringMatches(segment, userTags)
    stringMatches = [] // seguimos desactivando como antes

    // 2) Comparación y ajuste semántico/lógico
    const semanticMatches = await this.getSemanticMatches(
      lematizedTerm,
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

    return { matchingPhotoTags: allMatches, lematizedTerm }
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
    lematizedTerm: string,
    originalSegmentName: string,
    userTags,
    embeddingsProximityThreshold: number,
    photoIds: number[],
    categories: string[],
    areas: string[],
    searchMode: SearchMode
  ) {
    const { embeddings } = await this.modelsService.getEmbeddings([lematizedTerm])

    // Buscar similitud
    const similarTags = await this.embeddingsService.findSimilarTagToEmbedding(
      embeddings[0],
      embeddingsProximityThreshold,
      MAX_SIMILAR_TAGS,
      'cosine_similarity',
      userTags.map((t) => t.id),
      categories,
      areas,
      photoIds
    )

    // Ajustar proximidades según inferencia lógica
    const adjustedSimilarTags = await this.adjustProximities(
      originalSegmentName,
      similarTags,
      'tag',
      searchMode
    )

    return adjustedSimilarTags
  }

  public async getNearChunksFromDesc(photo: Photo, query: string, threshold: number = 0.1) {
    const similarChunks = await this.embeddingsService.findSimilarChunksToText(
      query,
      threshold,
      5,
      'cosine_similarity',
      [photo.id],
      ['story', 'context']
    )
    return similarChunks.map((ch) => {
      return { proximity: ch.proximity, text_chunk: ch.chunk }
    })
  }

  public async adjustProximities(term, tags, termsType = 'tag', searchMode: SearchMode) {
    let result

    // Low precision
    if (searchMode == 'low_precision') {
      return tags.filter((tag) => tag.proximity > 0)
    }

    const adjustedProximitiesByContext =
      await this.modelsService.adjustProximitiesByContextInference(term, tags, termsType)

    // Logical
    if (searchMode == 'logical') {
      result = adjustedProximitiesByContext.map((ap) => ({
        ...ap,
        proximity: ap.logicProximity,
      }))
      return result.filter((element) => element.proximity > 1)
      // Creative
    } else {
      result = adjustedProximitiesByContext.map((ap) => {
        const logicBonus = Math.max(ap.logicProximity, 0)
        const scaledBonus = Math.log1p(logicBonus)
        return {
          ...ap,
          proximity: ap.embeddingsProximity + scaledBonus,
        }
      })
      return result.filter((element) => element.proximity > 0)
    }
  }

  private calculateProximitiesScores(proximities) {
    const minProximity = Math.min(...proximities)
    const maxProximity = Math.max(...proximities)
    const totalProximities = proximities.reduce((sum, p) => sum + p, 0)
    const adjustedProximity = totalProximities / 2
    return maxProximity + Math.min(adjustedProximity, maxProximity)
  }

  private getMaxPotentialScore(structuredQuery, searchType: SearchType, weights) {
    // Valores que consideramos un match perfecto
    const maxProximity = 1.9
    const maxTagMatches = 0.5
    const maxChunkMatches = 0.5

    const maxRawScoreForTags = maxProximity + (maxTagMatches * maxProximity) / 2

    const maxRawScoreForChunks = maxProximity + (maxChunkMatches * maxProximity) / 2

    const maxRawScoreForFullQuery = maxRawScoreForChunks

    const currentWeights = weights[searchType]

    // Para cada segmento, el aporte máximo es la suma ponderada de tags y descripción
    const maxScorePerSegment =
      (currentWeights.tags > 0 ? maxRawScoreForTags * currentWeights.tags : 0) +
      (currentWeights.desc > 0 ? maxRawScoreForChunks * currentWeights.desc : 0)

    const segmentsCount = structuredQuery.positive_segments.length
    let maxPotentialScore = segmentsCount * maxScorePerSegment

    // Si se usa fullQuery (más de un segmento y el peso correspondiente es mayor a 0)
    if (segmentsCount > 1 && currentWeights.fullQuery > 0) {
      maxPotentialScore += maxRawScoreForFullQuery * currentWeights.fullQuery
    }

    return maxPotentialScore
  }
}
