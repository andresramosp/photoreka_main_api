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
import {
  MESSAGE_SEARCH_MODEL_CREATIVE,
  MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
  MESSAGE_SEARCH_MODEL_STRICT,
} from '../utils/prompts/insights.js'
import DescriptionChunk from '#models/descriptionChunk'
import EmbeddingsService from './embeddings_service.js'
import Tag from '#models/tag'

export type SearchMode = 'logical' | 'creative'
export type SearchType = 'semantic' | 'tags' | 'topological'

export type SearchOptions = {
  searchMode: SearchMode
  withInsights?: boolean
  iteration: number
  pageSize: number
}

export type SearchTagsOptions = SearchOptions & {
  included: string[]
  excluded: string[]
}

export type SearchTopologicalOptions = SearchOptions & {
  left: string
  right: string
  middle: string
}

export type SearchByPhotoOptions = {
  photoIds: number[]
  currentPhotosIds: number[]
  criteria: 'semantic' | 'embedding' | 'chromatic' | 'topological' | 'geometrical' | 'tags'
  opposite: boolean
  tagIds: number[] // para criteria 'tags'
  descriptionCategories: string[] // para criteria 'semantic
  withInsights?: boolean
  opposite: boolean
  resultLength: number
}

export default class SearchService {
  public modelsService: ModelsService = null
  public photoManager: PhotoManager = null
  public queryService: QueryService = null
  public scoringService: ScoringService = null
  public embeddingsService: EmbeddingsService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.photoManager = new PhotoManager()
    this.queryService = new QueryService()
    this.scoringService = new ScoringService()
    this.embeddingsService = new EmbeddingsService()
  }

  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  @withCostWS
  public async *searchSemantic(
    query: string,
    options: SearchOptions = {
      searchMode: 'logical',
      withInsights: false,
      pageSize: 18,
      iteration: 1,
    }
  ) {
    let { searchMode, withInsights, pageSize, iteration } = options
    const photos = await this.photoManager.getPhotosByUser('1234')

    const { structuredResult, sourceResult, useImage, expansionCost } =
      await this.queryService.structureQuery(query)

    let photosResult = []
    let modelCosts = []
    let attempts = 0

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTagsAndDesc(
      photos,
      structuredResult,
      searchMode
    )

    do {
      const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
        embeddingScoredPhotos,
        pageSize,
        iteration
      )

      yield {
        type: 'matches',
        data: {
          hasMore,
          results: {
            [iteration]: paginatedPhotos,
          },
          cost: { expansionCost },
          iteration: iteration,
          structuredResult,
        },
      }

      // Salvo que queramos procesar con IA los insights, ya tenemos el resultado de esta página
      if (!withInsights) {
        return
      }

      const batchSize = 4
      const maxPageAttempts = 1

      let photoBatches = []
      for (let i = 0; i < paginatedPhotos.length; i += batchSize) {
        photoBatches.push(paginatedPhotos.slice(i, i + batchSize))
      }

      const batchPromises = photoBatches.map(async (batch, index) => {
        await this.sleep(100 * index)
        const { modelResult, modelCost } = await this.processBatchInsightsImage(
          batch,
          structuredResult,
          searchMode
        )

        modelCosts.push(modelCost)

        return batch
          .map((item) => {
            console.log(modelResult)
            const result = modelResult.find((res) => res.id === item.photo.tempID)
            const reasoning = result?.reasoning || ''
            const isInsight =
              result?.isInsight == true || result?.isInsight == 'true' ? true : false

            return reasoning
              ? { photo: item.photo, score: item.tagScore, isInsight, reasoning }
              : { photo: item.photo, score: item.tagScore, isInsight }
          })
          .filter((item) => modelResult.find((res) => res.id === item.photo.tempID))
      })

      const batchResults = await Promise.all(batchPromises)
      photosResult = photosResult.concat(...batchResults.flat())

      iteration++
      attempts++

      yield {
        type: 'insights',
        data: {
          results: { [iteration - 1]: photosResult },
          hasMore,
          cost: { expansionCost, modelCosts },
          iteration: iteration - 1,
          structuredResult,
          requireSource: { source: sourceResult.requireSource, useImage },
        },
      }

      if (attempts >= maxPageAttempts || paginatedPhotos.length === 0) {
        yield {
          type: 'maxPageAttempts',
        }
        return
      }

      await this.sleep(750)
    } while (!photosResult.some((p) => p.isInsight))
  }

  //   @withCostWS
  public async *searchByTags(options: SearchTagsOptions) {
    const { included, excluded, iteration, pageSize, searchMode } = options
    const photos = await this.photoManager.getPhotosByUser('1234')

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTags(
      photos,
      included,
      excluded,
      searchMode
    )

    const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      iteration
    )

    yield {
      type: 'matches',
      data: {
        hasMore,
        results: {
          [iteration]: paginatedPhotos,
        },
        iteration: iteration,
      },
    }
  }

  public async *searchTopological(query: any, options: SearchTopologicalOptions) {
    const { pageSize, iteration, searchMode } = options
    const photos = await this.photoManager.getPhotosByUser('1234')

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTopoAreas(
      photos,
      {
        left: options.left,
        right: options.right,
        middle: options.middle,
      },
      searchMode
    )

    const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      iteration
    )

    yield {
      type: 'matches',
      data: {
        hasMore,
        results: {
          [iteration]: paginatedPhotos,
        },
        iteration: iteration,
      },
    }
  }

  public async searchByPhotosByVectors(query: SearchByPhotoOptions) {
    const { pageSize, iteration } = query
    const photos = await this.photoManager.getPhotosByUser('1234')
    const selectedPhotos = await this.photoManager.getPhotosByIds(query.photoIds)

    let scoredPhotos: Photo[]

    if (query.criteria === 'semantic') {
      // Excluir fotos ya mostradas
      const photosToSearch = photos.filter(
        (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
      )

      // Recopilar todos los chunks de todas las fotos base
      let baseChunks: DescriptionChunk[] = []
      for (const basePhoto of selectedPhotos) {
        await basePhoto.load('descriptionChunks')
        baseChunks.push(
          ...basePhoto.descriptionChunks.filter(
            (dc: DescriptionChunk) => dc.category === query.descriptionCategory
          )
        )
      }

      // Buscar chunks similares para cada chunk base
      const similarChunksArrays = await Promise.all(
        baseChunks.map((dc) =>
          this.embeddingsService.findSimilarChunkToEmbedding(
            dc.parsedEmbedding,
            0.4,
            50,
            'cosine_similarity',
            photosToSearch.map((p) => p.id),
            [query.descriptionCategory]
          )
        )
      )
      const similarChunks = similarChunksArrays.flat()

      // Combinar resultados: tomar el mayor proximity para cada chunk único
      const chunkMap = new Map<string | number, number>()
      similarChunks.forEach((chunk) => {
        if (!chunkMap.has(chunk.id) || chunk.proximity > chunkMap.get(chunk.id)) {
          chunkMap.set(chunk.id, chunk.proximity)
        }
      })

      // Filtrar y puntuar las fotos candidatas según los chunks coincidentes
      const relevantPhotos = photos.filter((photo) =>
        photo.descriptionChunks?.some((chunk) => chunkMap.has(chunk.id))
      )
      scoredPhotos = relevantPhotos.map((photo) => {
        const matchingChunks =
          photo.descriptionChunks?.filter((chunk) => chunkMap.has(chunk.id)) || []
        const proximities = matchingChunks.map((chunk) => chunkMap.get(chunk.id)!)
        const descScore = this.scoringService.calculateProximitiesScores(proximities)
        return { photo, descScore }
      })

      scoredPhotos = scoredPhotos
        .filter((sc) => sc.descScore > 0)
        .sort((a, b) => b.descScore - a.descScore)
        .map((sc) => sc.photo)
    }

    return scoredPhotos.slice(0, 3)
  }

  public async searchByPhotos(query: SearchByPhotoOptions): Promise<Photo[]> {
    const photos = await this.photoManager._getPhotosByUser('1234')
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
        if (idx === 0) return dc.parsedEmbedding.slice()
        return acc.map((val, i) => val + dc.parsedEmbedding[i])
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

  private async getEmbeddingScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    // Calcular el embedding visual combinado a partir de las fotos seleccionadas
    const visualEmbeddings = selectedPhotos.map((photo) => photo.parsedEmbedding)
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

  private async geGeometricalScoresByPhoto(
    query: SearchByPhotoOptions,
    photos: Photo[],
    selectedPhotos: Photo[]
  ): Promise<{ photo: Photo; score: number }[]> {
    const photosToSearch = photos.filter(
      (photo: Photo) => !query.currentPhotosIds.includes(photo.id)
    )

    const referencePhoto = photos[0]
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    const filePath = path.join(uploadPath, referencePhoto.name)
    const presenceMapBuffer = await fs.readFile(filePath)
    const base64 = (await sharp(presenceMapBuffer).toBuffer()).toString('base64')

    // Buscar fotos similares
    const similarPhotos = await this.modelsService.findSimilarPresenceMaps({
      id: referencePhoto.id,
      base64: base64,
    })

    const photoScoreMap = new Map<number | number, number>()
    similarPhotos.forEach((item) => {
      const proximity = 1 / (1 + item.distance) // opcional: transformar distancia en score
      if (!photoScoreMap.has(item.id) || proximity > photoScoreMap.get(item.id)!) {
        photoScoreMap.set(Number(item.id), proximity)
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
          tagPhoto.tag.parsedEmbedding &&
          (!query.tagIds || query.tagIds.includes(tagPhoto.tag.id))
        ) {
          const similarTags = await this.embeddingsService.findSimilarTagToEmbedding(
            tagPhoto.tag.parsedEmbedding,
            query.opposite ? 0.7 : 0.5,
            200,
            'cosine_similarity',
            null,
            null,
            [],
            photosToSearch.map((p) => p.id)
          )
          similarTags.forEach((result: any) => {
            similarTagMap.set(result.id, { name: result.name, proximity: result.proximity })
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
        if (similarTagMap.has(tagPhoto.tag.id)) {
          proximities.push(similarTagMap.get(tagPhoto.tag.id)?.proximity)
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

  public async processBatchInsightsDesc(
    batch: any[],
    structuredResult: any,
    searchMode: SearchMode
  ) {
    const searchModelMessage =
      searchMode == 'creative' ? MESSAGE_SEARCH_MODEL_CREATIVE(true) : MESSAGE_SEARCH_MODEL_STRICT()
    const photosWithChunks = []
    const defaultResultsMap: { [key: string]: any } = {}

    // Prellenamos defaultResultsMap para todas las fotos
    for (const batchedPhoto of batch) {
      defaultResultsMap[batchedPhoto.photo.tempID] = {
        id: batchedPhoto.photo.tempID,
        isInsight: false,
        reasoning: null,
      }
    }

    // Procesamos cada foto: si se obtienen chunks se añaden a la colección para el modelo
    for (const batchedPhoto of batch) {
      const descChunks = await this.scoringService.getNearChunksFromDesc(
        batchedPhoto.photo,
        structuredResult.no_prefix,
        0.1
      )
      const chunkedDesc = descChunks.map((dc) => dc.text_chunk).join(' ... ')
      if (chunkedDesc) {
        photosWithChunks.push({
          id: batchedPhoto.photo.tempID,
          description: chunkedDesc,
          visual_accents: batchedPhoto.photo.descriptions.visual_accents,
        })
      }
    }

    // Llamamos al modelo con las fotos que tienen chunks
    let modelResponse
    if (photosWithChunks.length) {
      modelResponse = await this.modelsService.getGPTResponse(
        searchModelMessage,
        JSON.stringify({
          query: structuredResult.original,
          collection: photosWithChunks,
        }),
        'gpt-4o', //deepseek-chat
        null,
        1.1,
        false
      )
    }

    // Sobreescribimos defaultResultsMap con los resultados que devuelve el modelo
    const modelResults = modelResponse ? modelResponse.result : []
    for (const result of modelResults) {
      defaultResultsMap[result.id] = result
    }

    const combinedResults = batch.map(
      (batchedPhoto) => defaultResultsMap[batchedPhoto.photo.tempID]
    )

    return {
      modelResult: combinedResults,
      modelCost: modelResponse ? modelResponse.cost : 0,
    }
  }

  public async processBatchInsightsImage(
    batch: any[],
    structuredResult: any,
    searchMode: SearchMode
  ) {
    const searchModelMessage = MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE

    const imagesPayload = await this.generateImagesPayload(batch.map((cp) => cp.photo))

    // Prellenamos un mapa por posición
    const defaultResults: any[] = batch.map((cp) => ({
      id: cp.photo.tempID,
      isInsight: false,
      reasoning: null,
    }))

    let modelResult = []
    let modelCost = 0

    if (imagesPayload.length) {
      const response = await this.modelsService.getGPTResponse(
        searchModelMessage(),
        [
          {
            type: 'text',
            text: JSON.stringify({ query: structuredResult.original }),
          },
          ...imagesPayload,
        ],
        'gpt-4o',
        null,
        1.1,
        false
      )

      modelResult = response.result || []
      modelCost = response.cost || 0
    }

    // Reemplazamos los resultados por los devueltos por el modelo, respetando el orden
    for (let i = 0; i < modelResult.length; i++) {
      defaultResults[i] = {
        id: batch[i].photo.tempID,
        ...modelResult[i],
      }
    }

    return {
      modelResult: defaultResults,
      modelCost,
    }
  }

  // AUXILIARES //

  private getPaginatedPhotosByPage(embeddingScoredPhotos, pageSize, currentIteration) {
    const offset = (currentIteration - 1) * pageSize
    const paginatedPhotos = embeddingScoredPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < embeddingScoredPhotos.length
    return { hasMore, paginatedPhotos }
  }

  private getPaginatedPhotosByPercent(embeddingScoredPhotos, percent, currentIteration) {
    const maxMatchPercent = Math.max(...embeddingScoredPhotos.map((photo) => photo.matchPercent))

    // Calcular los límites del intervalo para la iteración actual
    const upperBound = maxMatchPercent - (currentIteration - 1) * percent
    const lowerBound = upperBound - 15

    // Filtrar las fotos que caen en el rango definido
    const paginatedPhotos = embeddingScoredPhotos.filter(
      (photo) => photo.matchPercent < upperBound && photo.matchPercent >= lowerBound
    )

    // Determinar si hay más fotos en rangos inferiores
    const hasMore = embeddingScoredPhotos.some((photo) => photo.matchPercent < lowerBound)
    return { hasMore, paginatedPhotos }
  }

  public async generateImagesPayload(photos: Photo[]) {
    const validImages: any[] = []
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`)

      try {
        await fs.access(filePath)

        const resizedBuffer = await sharp(filePath)
          // .resize({ width: 1012, fit: 'inside' })
          .toBuffer()

        validImages.push({
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    return validImages.map(({ base64 }) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${base64}`,
        detail: 'low',
      },
    }))
  }
}
