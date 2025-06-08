// @ts-nocheck

import Photo from '#models/photo'
import DescriptionChunk from '#models/descriptionChunk'

import ModelsService from './models_service.js'
import PhotoManager from '../managers/photo_manager.js'
import VisualFeaturesService from './visual_features_service.js'
import ScoringService from './scoring_service.js'
import EmbeddingsService from './embeddings_service.js'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

export type SearchByPhotoOptions = {
  anchorIds: number[]
  currentPhotosIds: number[]
  criteria: 'semantic' | 'embedding' | 'chromatic' | 'composition' | 'geometrical' | 'tags'
  tagIds: number[]
  boxesIds: number[]
  descriptionCategories: string[]
  opposite: boolean
  inverted: boolean
  resultLength: number
}

export default class SearchPhotoService {
  private photoManager = new PhotoManager()
  private visualFeaturesService = new VisualFeaturesService()
  private scoringService = new ScoringService()
  private embeddingsService = new EmbeddingsService()

  public async searchByPhotos(query: SearchByPhotoOptions): Promise<(Photo & { score: number })[]> {
    if (!query.anchorIds?.length) return []

    const userPhotoIds = await this.photoManager.getPhotosIdsByUser('1234')

    const anchors = await this.photoManager.getPhotosByIds(query.anchorIds)
    if (!anchors.length) return []

    const candidateIds = userPhotoIds.filter(
      (id) => !query.anchorIds.includes(id) && !query.currentPhotosIds.includes(id)
    )
    if (!candidateIds.length) return []

    let scored: { id: number; score: number }[] = []
    switch (query.criteria) {
      case 'semantic':
        scored = await this.scoreSemantic(query, candidateIds, anchors)
        break
      case 'embedding':
        scored = await this.scoreEmbedding(query, candidateIds, anchors)
        break
      case 'tags':
        scored = await this.scoreTags(query, candidateIds, anchors)
        break
      case 'composition':
        scored = await this.scoreComposition(query, candidateIds, anchors[0])
        break
      case 'geometrical':
        scored = await this.scoreGeometrical(query, candidateIds, anchors)
        break
      default:
        return []
    }

    if (!scored.length) return []

    // Ordenamos todos los candidatos
    const scoredSorted = scored.sort((a, b) =>
      query.opposite ? a.score - b.score : b.score - a.score
    )

    // Aplicamos slice antes de pedir a DB
    const topScored = scoredSorted.slice(0, query.resultLength)
    const topIds = topScored.map(({ id }) => id)
    const scoreMap = Object.fromEntries(topScored.map(({ id, score }) => [id, score]))

    // Obtenemos solo las fotos necesarias
    const photos = await this.photoManager.getPhotosByIds(topIds.map(String))
    const photoMap = new Map(photos.map((p) => [p.id, p.serialize()]))

    // Añadimos el score y devolvemos
    const sortedPhotosWithScore = topIds
      .map((id) => {
        const serialized = photoMap.get(id)
        if (serialized) {
          serialized.score = scoreMap[id]
        }
        return serialized
      })
      .filter(Boolean)

    return sortedPhotosWithScore
  }

  /* ───────────────────── Strategy helpers ───────────────────── */

  private async scoreSemantic(
    query: SearchByPhotoOptions,
    candidateIds: number[],
    anchors: Photo[]
  ) {
    for (const p of anchors) if (!p.descriptionChunks) await p.load('descriptionChunks')

    const baseChunks: DescriptionChunk[] = []
    anchors.forEach((p) => {
      baseChunks.push(
        ...p.descriptionChunks.filter((dc) => query.descriptionCategories.includes(dc.category))
      )
    })
    if (!baseChunks.length) return []

    const combined = baseChunks
      .reduce((acc: number[], dc, idx) => {
        const e = EmbeddingsService.getParsedEmbedding(dc.embedding)
        return idx === 0 ? e.slice() : acc.map((v, i) => v + e[i])
      }, [])
      .map((v) => v / baseChunks.length)

    const similar = await this.embeddingsService.findSimilarChunkToEmbedding(
      combined,
      query.opposite ? 1 : 0.5,
      200,
      'cosine_similarity',
      candidateIds,
      query.descriptionCategories,
      undefined,
      query.opposite
    )

    const best: Record<number, number> = {}
    similar.forEach((c) => {
      if (!best[c.photo_id] || c.proximity > best[c.photo_id]) best[c.photo_id] = c.proximity
    })
    return Object.entries(best).map(([id, score]) => ({ id: +id, score }))
  }

  @MeasureExecutionTime
  private async scoreEmbedding(
    query: SearchByPhotoOptions,
    candidateIds: number[],
    anchors: Photo[]
  ) {
    const anchorEmbeddings = anchors
      .filter((p) => p.embedding)
      .map((p) => EmbeddingsService.getParsedEmbedding(p.embedding))
    if (!anchorEmbeddings.length) return []

    const combinedEmbedding = anchorEmbeddings
      .reduce((acc, e, i) => (i === 0 ? e.slice() : acc.map((v, idx) => v + e[idx])), [])
      .map((v) => v / anchorEmbeddings.length)

    const similar = await this.embeddingsService.findSimilarPhotoToEmbedding(
      combinedEmbedding,
      query.opposite ? 1 : 0.4,
      200,
      'cosine_similarity',
      query.opposite
    )

    return similar
      .filter((s) => candidateIds.includes(s.id))
      .map((s) => ({ id: s.id, score: s.proximity }))
  }

  private async scoreTags(query: SearchByPhotoOptions, candidateIds: number[], anchors: Photo[]) {
    const tagScoreMap: Record<number, number[]> = {}
    for (const anchor of anchors) {
      for (const tagPhoto of anchor.tags) {
        if (query.tagIds.length && !query.tagIds.includes(tagPhoto.tag.id)) continue
        const tagEmb = EmbeddingsService.getParsedEmbedding(tagPhoto.tag.embedding)
        const similar = await this.embeddingsService.findSimilarTagToEmbedding(
          tagEmb,
          query.opposite ? 1 : 0.5,
          200,
          'cosine_similarity',
          null,
          null,
          [],
          candidateIds
        )
        similar.forEach((t) => {
          if (!tagScoreMap[t.photo_id]) tagScoreMap[t.photo_id] = []
          tagScoreMap[t.photo_id].push(t.proximity)
        })
      }
    }
    return Object.entries(tagScoreMap)
      .map(([id, prox]) => ({
        id: +id,
        score: this.scoringService.calculateProximitiesScores(prox),
      }))
      .filter((o) => o.score > 0)
  }

  private async scoreComposition(
    query: SearchByPhotoOptions,
    candidateIds: number[],
    reference: Photo
  ) {
    // call with the correct signature (no candidateIds param)
    const hits = await this.visualFeaturesService.findSimilarPhotosByDetections(
      reference,
      query.boxesIds,
      ['animal', 'person', 'prominent object', 'architectural feature'],
      ['animal', 'person', 'prominent object', 'architectural feature'],
      query.inverted
    )

    // Filter only those hits that belong to the candidate universe
    return hits
      .filter((h) => candidateIds.includes(h.id))
      .map((h) => ({ id: h.id, score: h.score }))
  }

  private async scoreGeometrical(..._args: any[]) {
    return []
  }
}
