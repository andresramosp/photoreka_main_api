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

export default class SearchTextService {
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
