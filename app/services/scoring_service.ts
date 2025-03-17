// @ts-nocheck

import Tag from '#models/tag'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { createRequire } from 'module'
import EmbeddingsService from './embeddings_service.js'
import { withCache } from '../decorators/withCache.js'
import type { SearchMode, SearchType } from './search_service.js'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const cache = new NodeCache({ stdTTL: 3600 })

interface ScoredPhoto {
  photo: Photo
  tagScore?: number // Puntuación por tags
  descScore?: number // Puntuación por embeddings
  totalScore?: number // Puntaje total calculado
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
      tags: isCreative ? 0.3 : 0.4,
      desc: isCreative ? 0.7 : 0.6,
      fullQuery: 2,
      embeddingsTagsThreshold: 0.13,
      embeddingsDescsThreshold: 0.17,
      embeddingsFullQueryThreshold: 0.3,
    },
    topological: {
      tags: 0,
      desc: 1,
      fullQuery: 2.5,
      embeddingsDescsThreshold: 0.1,
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

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
  }

  // @MeasureExecutionTime
  // TODO: userid!!
  // @withCache({
  //   key: (_, arg2, arg3, arg4) => `getScoredPhotosByTagsAndDesc_ ${arg2.original}_${arg3}`,
  //   provider: 'redis',
  //   ttl: 60 * 5,
  // })
  public async getScoredPhotosByTagsAndDesc(
    photos: Photo[],
    structuredQuery: any,
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    let weights = getWeights(searchMode == 'creative')
    let aggregatedScores: ScoredPhoto[] = photos.map((photo) => ({
      photo,
      tagScore: 0,
      descScore: 0,
      totalScore: 0,
    }))

    const strictInference = searchMode == 'logical'

    const performFullQuerySearch = structuredQuery.positive_segments.length > 1

    const fullQueryPromise: Promise<ScoredPhoto[]> = performFullQuerySearch
      ? this.getScoredPhotoDescBySegment(
          photos,
          { name: structuredQuery.no_prefix, index: -1 },
          weights.semantic.embeddingsFullQueryThreshold,
          strictInference,
          true,
          ['context', 'story']
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
              strictInference,
              ['context_story', 'topology'],
              ['context', 'story']
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
          strictInference,
          ['context_story', 'topology'],
          ['context', 'story']
        )
      }
      return scores
    })()

    // Esperamos ambas promesas en paralelo.
    const [scoresAfterSegments, fullQueryDescScores, nuancesQueryTagsScore] = await Promise.all([
      segmentsPromise,
      fullQueryPromise,
      nuancesQuery,
    ])

    // Mergeamos el score fullQuery en los resultados finales.
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

    return finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => {
        return b.totalScore - a.totalScore
      })
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
      }))
  }

  // TODO: replantear: tiene
  private async filterExcludedPhotosByTags(photos: Photo[], excluded: string[]) {
    const proximityThreshold = 1 + 0.6
    const allTags = await Tag.all()

    const matchingPromises = excluded.map((tag) =>
      this.findMatchingTagsForSegment({ name: tag, index: 1 }, allTags, 0.2, true, photos)
    )
    const matchingResults = await Promise.all(matchingPromises)
    const allExcludedTags = matchingResults.map((mr) => mr.matchingTags).flat()
    const excludedTagNames = allExcludedTags
      .filter((t) => t.proximity > proximityThreshold)
      .map((t) => t.name)

    console.log(`Excluded: ${excludedTagNames}`)

    return photos.filter((photo) => !photo.tags?.some((tag) => excludedTagNames.includes(tag.name)))
  }

  // TODO: userid!!
  // @withCache({
  //   key: (_, arg2, arg3, arg4) =>
  //     `getScoredPhotosByTags_${JSON.stringify(arg2)}_${JSON.stringify(arg3)}_${arg4}`,
  //   provider: 'redis',
  //   ttl: 120,
  // })
  public async getScoredPhotosByTags(
    photos: Photo[],
    included: string[],
    excluded: string[],
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    let weights = getWeights(searchMode == 'creative') // TODO: añadir parametros

    let filteredPhotos = await this.filterExcludedPhotosByTags(photos, excluded)

    let aggregatedScores: ScoredPhoto[] = filteredPhotos.map((photo) => ({
      photo,
      tagScore: 0,
      totalScore: 1, // Para que devuelva algo si solo hay negativos
    }))

    const includedPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, segment] of included.entries()) {
        scores = await this.processSegment(
          { name: segment, index },
          scores,
          weights.tags,
          searchMode == 'logical',
          ['context_story', 'topology'],
          ['context', 'story']
        )
      }
      return scores
    })()

    // Esperamos ambas promesas en paralelo.
    const [finalScores] = await Promise.all([includedPromise])

    let potentialMaxScore = 10 // //this.getMaxPotentialScore(structuredQuery, searchType, weights)

    return finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => {
        return b.totalScore - a.totalScore
      })
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
      }))
  }

  // TODO: cache
  // TODO: Probar solo excluir area contraria
  public async getScoredPhotosByTopoAreas(
    photos: Photo[],
    queryByAreas: { left: string; right: string; upper: string; bottom: string; middle: string },
    searchMode: SearchMode
  ): Promise<ScoredPhoto[] | undefined> {
    let weights = getWeights(searchMode == 'creative')

    let aggregatedScores: ScoredPhoto[] = photos.map((photo) => ({
      photo,
      tagScore: 0,
      totalScore: 1,
    }))

    // Determinar qué áreas tienen contenido en la consulta
    const filledAreas = Object.entries(queryByAreas)
      .filter(([_, value]) => value?.trim()) // Filtrar áreas vacías
      .map(([area, value]) => ({ area, content: value })) // Mapeamos el área con su contenido

    const includedPromise = (async () => {
      let scores = aggregatedScores
      for (const [index, { area, content }] of filledAreas.entries()) {
        const areasToSearch = area != 'middle' ? [area, 'middle'] : ['middle']

        scores = await this.processSegment(
          { name: content, index }, // Pasamos el contenido real
          scores,
          weights.topological,
          searchMode == 'logical',
          [],
          ['topology'],
          areasToSearch
        )
      }
      return scores
    })()

    // Esperamos la promesa
    const [finalScores] = await Promise.all([includedPromise])

    let potentialMaxScore = 10 // //this.getMaxPotentialScore(structuredQuery, searchType, weights)

    return finalScores
      .filter((scores) => scores.totalScore > 0)
      .sort((a, b) => b.totalScore - a.totalScore)
      .map((score) => ({
        ...score,
        matchPercent: Math.min(100, (score.totalScore * 100) / potentialMaxScore),
      }))
  }

  private mergeTagDescScoredPhotos(
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

  private async processSegment(
    segment: { name: string; index: number },
    aggregatedScores: ScoredPhoto[],
    weights: { tags: number; desc: number; fullQuery: number },
    strictInference: boolean,
    tagsCategories: string[],
    descCategories: string[],
    areas: string[]
  ): Promise<ScoredPhoto[]> {
    const photosToReview = aggregatedScores.map((s) => s.photo)
    const tagPromise =
      weights.tags > 0
        ? this.getScoredPhotoTagsBySegment(
            photosToReview,
            segment,
            weights.embeddingsTagsThreshold,
            strictInference,
            tagsCategories
          )
        : Promise.resolve([])
    const descPromise =
      weights.desc > 0
        ? this.getScoredPhotoDescBySegment(
            photosToReview,
            segment,
            weights.embeddingsDescsThreshold,
            strictInference,
            false,
            descCategories,
            areas
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

    return updatedScores.filter((score) => matchingSegmentPhotoIds.includes(score.photo.id))
  }

  // TODO: hay que penalizar un poco matcheos negativos
  private async getScoredPhotoDescBySegment(
    photos: Photo[],
    segment: { name: string; index: number },
    embeddingsProximityThreshold: number = 0.2,
    strictInference: boolean,
    isFullQuery: boolean = false,
    categories: string[],
    areas: string[]
  ): Promise<{ photo: Photo; descScore: number }[]> {
    // Obtener los chunks similares para el segmento
    const matchingChunks = await this.embeddingsService.findSimilarChunksToText(
      segment.name,
      embeddingsProximityThreshold,
      MAX_SIMILAR_CHUNKS,
      'cosine_similarity',
      photos.map((photo) => photo.id),
      categories,
      areas
    )

    let adjustedChunks = await this.adjustProximities(
      segment.name,
      matchingChunks.map((mc) => ({
        name: mc.chunk,
        proximity: mc.proximity,
        id: mc.id,
      })),
      'desc',
      strictInference
    )

    // Crear un mapa de chunk id a proximidad ajustada
    const chunkMap = new Map<string | number, number>(
      adjustedChunks.map((chunk) => [chunk.id, chunk.proximity])
    )

    // Filtrar las fotos que tienen al menos un chunk relevante
    const relevantPhotos = photos.filter((photo) =>
      photo.descriptionChunks?.some((chunk) => chunkMap.has(chunk.id))
    )

    console.log(`[DESC] Relevant photos for ${segment.name}: ${relevantPhotos.length}`)

    // Calcular el score para cada foto basado en los chunks coincidentes
    let scoredPhotos = relevantPhotos.map((photo) => {
      if (photo.id == '333') {
        console.log()
      }
      photo.matchingChunks = photo.matchingChunks || []
      const matchingPhotoChunks =
        photo.descriptionChunks?.filter((chunk) => chunkMap.has(chunk.id)) || []
      photo.matchingChunks = [
        ...photo.matchingChunks,
        ...matchingPhotoChunks
          .filter((item) => chunkMap.get(item.id) > 0)
          .map((item) => ({
            chunk: item.chunk,
            proximity: chunkMap.get(item.id),
            isFullQuery,
          })),
      ]

      const proximities = matchingPhotoChunks.map((chunk) => chunkMap.get(chunk.id)!)
      let descScore = this.calculateProximitiesScores(proximities)

      return { photo, descScore }
    })

    // Ordenar de mayor a menor y filtrar según la configuración
    scoredPhotos = scoredPhotos
      .filter((score) => score.descScore > 0)
      .sort((a, b) => b.descScore - a.descScore)
    return scoredPhotos
  }

  private async getScoredPhotoTagsBySegment(
    photos: Photo[],
    segment: { name: string; index: number },
    embeddingsProximityThreshold: number = 0.15,
    strictInference: boolean,
    categories?: string[] // parámetro opcional para filtrar por categoría
  ): Promise<{ photo: Photo; tagScore: number }[]> {
    const allTags = await Tag.all() // By user!

    // Obtenemos los matching tags directamente del segmento
    const { matchingTags } = await this.findMatchingTagsForSegment(
      segment,
      allTags,
      embeddingsProximityThreshold,
      strictInference,
      photos,
      categories
    )
    const tagMap = new Map<string, number>()
    matchingTags.forEach((tag: any) => {
      tagMap.set(tag.name, tag.proximity)
    })

    // Calcular el score para cada foto basándonos en los tags coincidentes,
    // aplicando un filtro extra para que el tag coincida con la categoría indicada
    let scoredPhotos = photos.map((photo) => {
      photo.matchingTags = photo.matchingTags || []
      const matchingPhotoTags =
        photo.tags?.filter((tag) => {
          return tagMap.has(tag.name) && (!categories || categories.includes(tag.category))
        }) || []
      photo.matchingTags = [
        ...photo.matchingTags,
        ...matchingPhotoTags.map((tag) => ({ name: tag.name, proximity: tagMap.get(tag.name) })),
      ]
      let tagScore = 0
      if (matchingPhotoTags.length > 0) {
        const proximities = matchingPhotoTags.map((tag) => tagMap.get(tag.name)!)
        tagScore = this.calculateProximitiesScores(proximities)
      }
      return { photo, tagScore }
    })

    scoredPhotos = scoredPhotos
      .filter((score) => score.tagScore > 0)
      .sort((a, b) => b.tagScore - a.tagScore)
    return scoredPhotos
  }

  public async findMatchingTagsForSegment(
    segment: { name: string; index: number },
    tags,
    embeddingsProximityThreshold: number,
    strictInference: boolean,
    photos: Photo[],
    categories: string[]
  ) {
    // 1) Comparación por cadenas
    const { lematizedTerm, stringMatches, remainingTags } = this.getStringMatches(segment, tags)

    // 2) Comparación y ajuste semántico/lógico
    const semanticMatches = await this.getSemanticMatches(
      lematizedTerm,
      segment.name,
      remainingTags,
      embeddingsProximityThreshold,
      photos,
      categories,
      strictInference
    )

    // Combinar y filtrar duplicados
    const allMatches = [...stringMatches, ...semanticMatches]
    const uniqueMatches = allMatches.filter(
      (match, index, self) => index === self.findIndex((t) => t.name === match.name)
    )

    return { matchingTags: uniqueMatches, lematizedTerm }
  }

  private getStringMatches(segment: { name: string; index: number }, tags) {
    const lematizedTerm = pluralize.singular(segment.name.toLowerCase())
    const termWordCount = lematizedTerm.split(' ').length

    const lematizedTagNames = tags.map((tag) => ({
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
      name: tags.find((t) => t.id === tag.id).name,
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
    remainingTags,
    embeddingsProximityThreshold: number,
    photos: Photo[],
    categories: string[],
    strictInference: boolean
  ) {
    const { embeddings } = await this.modelsService.getEmbeddings([lematizedTerm])

    // Buscar similitud
    const similarTags = await this.embeddingsService.findSimilarTagToEmbedding(
      embeddings[0],
      embeddingsProximityThreshold,
      MAX_SIMILAR_TAGS,
      'cosine_similarity',
      remainingTags.map((t) => t.id),
      categories,
      photos.map((p) => p.id)
    )

    // Ajustar proximidades según inferencia lógica
    const adjustedSimilarTags = await this.adjustProximities(
      originalSegmentName,
      similarTags,
      'tag',
      strictInference
    )

    return adjustedSimilarTags.map((tag) => ({
      name: tag.name,
      proximity: tag.proximity,
      embeddingsProximity: tag.embeddingsProximity,
    }))
  }

  public async getNearChunksFromDesc(photo: Photo, query: string, threshold: number = 0.1) {
    if (!photo.descriptionChunks.length) {
      await this.analyzerService.processDesc(photo.description, photo.id)
    }
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

  public async adjustProximities(term, tags, termsType = 'tag', strictInference) {
    let result

    const adjustedProximitiesByContext =
      await this.modelsService.adjustProximitiesByContextInference(
        term,
        tags,
        termsType,
        strictInference
      )

    if (strictInference) {
      result = adjustedProximitiesByContext.map((ap) => ({
        ...ap,
        proximity: ap.logicProximity,
      }))
      return result.filter((element) => element.proximity > 1) // logic + entailment
    } else {
      result = adjustedProximitiesByContext.map((ap) => {
        const logicBonus = Math.max(ap.logicProximity, 0) // Asegurar que no sea negativo
        const scaledBonus = Math.log1p(logicBonus) // Aplica curva logarítmica
        return {
          ...ap,
          proximity: ap.embeddingsProximity + scaledBonus,
        }
      })
      return result.filter((element) => element.proximity > 0) // embeddings + bonus
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
