// @ts-nocheck

import Photo from '#models/photo'
import fs from 'fs/promises'

import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import QueryService from './query_service.js'
import withCostWS from '../decorators/withCostWs.js'
import ScoringService from './scoring_service.js'
import { withCache } from '../decorators/withCache.js'

import PhotoManager from '../managers/photo_manager.js'

import DescriptionChunk from '#models/descriptionChunk'
import EmbeddingsService from './embeddings_service.js'
import VisualFeaturesService from './visual_features_service.js'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

export type SearchByPhotoOptions = {
  photoIds: number[]
  currentPhotosIds: number[]
  criteria: 'semantic' | 'embedding' | 'chromatic' | 'composition' | 'geometrical' | 'tags'
  tagIds: number[] // para criteria 'tags'
  boxesIds: number[] // para criteria 'composition'
  descriptionCategories: string[] // para criteria 'semantic
  withInsights?: boolean
  opposite: boolean
  inverted: boolean
  resultLength: number
}

export default class SearchPhotoService {
  public modelsService: ModelsService = null
  public photoManager: PhotoManager = null
  public visualFeaturesService: VisualFeaturesService = null
  public scoringService: ScoringService = null
  public embeddingsService: EmbeddingsService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.photoManager = new PhotoManager()
    this.visualFeaturesService = new VisualFeaturesService()
    this.scoringService = new ScoringService()
    this.embeddingsService = new EmbeddingsService()
  }

  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public async searchByPhotos(query: SearchByPhotoOptions): Promise<Photo[]> {
    const photos = await this.photoManager.getPhotos('1234', true)
    const selectedPhotos = await this.photoManager.getPhotosByIds(query.photoIds)
    let scoredPhotos: { photo: Photo; score: number }[] = []

    if (query.criteria === 'semantic') {
      scoredPhotos = await this.getSemanticScoresByPhoto(query, photos, selectedPhotos)
    } else if (query.criteria === 'embedding') {
      scoredPhotos = await this.getEmbeddingScoresByPhoto(query, photos, selectedPhotos)
    } else if (query.criteria === 'tags') {
      scoredPhotos = await this.getTagBasedScoresByPhoto(query, photos, selectedPhotos)
    } else if (query.criteria === 'geometrical') {
      scoredPhotos = await this.geGeometricalScoresByPhoto(query, photos, selectedPhotos)
    } else if (query.criteria === 'composition') {
      scoredPhotos = await this.getCompositionalScoresByPhoto(query, photos, selectedPhotos)
    }

    return scoredPhotos
      .sort((a, b) => (query.opposite ? a.score - b.score : b.score - a.score))
      .slice(0, query.resultLength)
      .map((scored) => scored.photo)
  }

  private async getSemanticScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    let baseChunks: DescriptionChunk[] = []
    for (const basePhoto of selectedPhotos) {
      await basePhoto.load('descriptionChunks')
      baseChunks.push(
        ...basePhoto.descriptionChunks.filter((dc: DescriptionChunk) =>
          query.descriptionCategories.includes(dc.category)
        )
      )
    }
    if (baseChunks.length === 0) return []

    const combinedEmbedding = baseChunks
      .reduce((acc: number[], dc: DescriptionChunk, idx: number) => {
        if (idx === 0) return dc.getParsedEmbedding().slice()
        return acc.map((val, i) => val + dc.getParsedEmbedding()[i])
      }, [])
      .map((val) => val / baseChunks.length)

    const similarChunks = await this.embeddingsService.findSimilarChunkToEmbedding(
      combinedEmbedding,
      query.opposite ? 0.7 : 0.5,
      50,
      'cosine_similarity',
      photosToSearch.map((p) => p.id),
      query.descriptionCategories,
      null,
      query.opposite
    )

    const chunkMap = new Map<string | number, number>()
    similarChunks.forEach((chunk) => {
      if (!chunkMap.has(chunk.id) || chunk.proximity > chunkMap.get(chunk.id)) {
        chunkMap.set(chunk.id, chunk.proximity)
      }
    })

    return photos
      .filter((photo) => photo.descriptionChunks?.some((chunk) => chunkMap.has(chunk.id)))
      .map((photo) => {
        const matchingChunks =
          photo.descriptionChunks?.filter((chunk) => chunkMap.has(chunk.id)) || []
        const proximities = matchingChunks.map((chunk) => chunkMap.get(chunk.id)!)
        const descScore = this.scoringService.calculateProximitiesScores(proximities)
        return { photo, score: descScore }
      })
      .filter((scored) => scored.score > 0)
  }

  @MeasureExecutionTime
  private async getEmbeddingScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    // Calcular el embedding visual combinado a partir de las fotos seleccionadas
    const visualEmbeddings = selectedPhotos.map((photo) => photo.getParsedEmbedding())
    if (visualEmbeddings.length === 0) return []

    const combinedEmbedding = visualEmbeddings
      .reduce((acc, emb, idx) => {
        if (idx === 0) return emb.slice()
        return acc.map((val, i) => val + emb[i])
      }, new Array(visualEmbeddings[0].length).fill(0))
      .map((val) => val / visualEmbeddings.length)

    // Buscar fotos similares usando el método findSimilarPhotoToEmbedding
    const similarPhotos = await this.embeddingsService.findSimilarPhotoToEmbedding(
      combinedEmbedding,
      query.opposite ? 0.7 : 0.4,
      50,
      'cosine_similarity',
      query.opposite
    )

    const photoScoreMap = new Map<string | number, number>()
    similarPhotos.forEach((item) => {
      if (!photoScoreMap.has(item.id) || item.proximity > photoScoreMap.get(item.id)) {
        photoScoreMap.set(item.id, item.proximity)
      }
    })

    return photosToSearch
      .filter((photo) => photoScoreMap.has(photo.id))
      .map((photo) => ({ photo, score: photoScoreMap.get(photo.id)! }))
  }

  private async getTagBasedScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    // Filtrar las fotos candidatas
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    // Mapa global para acumular los resultados de findSimilarTagToEmbedding sin considerar área.
    const similarTagMap = new Map<string | number, { name: string; proximity: number }>()

    // Para cada TagPhoto de las fotos base, buscar tags similares individualmente.
    for (const basePhoto of selectedPhotos) {
      for (const tagPhoto of basePhoto.tags) {
        // Si se pasa una lista de tagIds, solo se consideran aquellos que estén en la lista.
        if (
          tagPhoto.tag.getParsedEmbedding() &&
          (!query.tagIds || query.tagIds.includes(tagPhoto.tag.id))
        ) {
          const similarTags = await this.embeddingsService.findSimilarTagToEmbedding(
            tagPhoto.tag.getParsedEmbedding(),
            query.opposite ? 0.7 : 0.5,
            200,
            'cosine_similarity',
            null,
            null,
            [],
            photosToSearch.map((p) => p.id)
          )
          similarTags.forEach((result: any) => {
            similarTagMap.set(result.tag_photo_id, {
              name: result.name,
              proximity: result.proximity,
            })
          })
        }
      }
    }

    // Para cada foto candidata, cargar sus TagPhotos y sus tags, y acumular las proximidades
    // si el tag global coincide con los resultados en similarTagMap.
    const scoredPhotos: { photo: Photo; score: number }[] = []
    for (const photo of photosToSearch) {
      const proximities: number[] = []
      for (const tagPhoto of photo.tags) {
        if (similarTagMap.has(tagPhoto.id)) {
          proximities.push(similarTagMap.get(tagPhoto.id)?.proximity)
        }
      }
      if (proximities.length > 0) {
        const score = this.scoringService.calculateProximitiesScores(proximities)
        if (score > 0) {
          scoredPhotos.push({ photo, score })
        }
      }
    }

    return scoredPhotos
  }

  private async getCompositionalScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    const referencePhoto = selectedPhotos[0] // admitir varias!

    const similarPhotos = await this.visualFeaturesService.findSimilarPhotosByDetections(
      referencePhoto,
      query.boxesIds,
      ['animal', 'person', 'prominent object', 'architectural feature'],
      ['animal', 'person', 'prominent object', 'architectural feature'],
      query.inverted
    )

    return photosToSearch
      .filter((p) => similarPhotos.map((sp) => sp.id).includes(p.id))
      .map((photo) => {
        const overlapScore = similarPhotos.find((sp) => sp.id == photo.id).score
        return { photo, score: overlapScore }
      })
  }
}
