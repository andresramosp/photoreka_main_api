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
  MESSAGE_SEARCH_MODEL_CREATIVE_SCORED_IMAGE,
  MESSAGE_SEARCH_MODEL_STRICT,
} from '../utils/prompts/insights.js'
import pLimit from 'p-limit'
import DescriptionChunk from '#models/descriptionChunk'
import VectorService from './vector_service.js'
import Tag from '#models/tag'
import { getUploadPath } from '../utils/dataPath.js'
import PhotoImageService from './photo_image_service.js'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { MediaResolution } from '@google/genai'

export type SearchMode = 'logical' | 'flexible' | 'low_precision' | 'curation'
export type SearchType = 'semantic' | 'tags' | 'topological'

export type SearchOptions = {
  searchMode: SearchMode
  iteration: number
  pageSize: number
  minMatchScore?: number
  userId?: number
  maxPageAttempts?: number
  minResults?: number
  collections?: string[]
  visualAspects?: string[]
  artisticScores?: string[]
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
  public vectorService: VectorService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.photoManager = new PhotoManager()
    this.queryService = new QueryService()
    this.scoringService = new ScoringService()
    this.vectorService = new VectorService()
  }

  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public async *searchSemanticStream(
    query: string,
    userId: string | number,
    options: SearchOptions = {
      searchMode: 'logical',
      pageSize: 18,
      iteration: 1,
    }
  ) {
    let {
      searchMode,
      pageSize,
      iteration,
      minMatchScore,
      maxPageAttempts = 6,
      minResults,
      collections,
      visualAspects,
      artisticScores,
    } = options

    const photoIds = await this.photoManager.getPhotosIdsForSearch(
      userId?.toString(),
      collections && collections.length > 0 ? collections : undefined,
      visualAspects && visualAspects.length > 0 ? visualAspects : undefined,
      artisticScores && artisticScores.length > 0 ? artisticScores : undefined
    )

    const { structuredResult, useImage, expansionCost } = await this.queryService.structureQuery(
      query,
      searchMode
    )

    let photosResult = []
    let modelCosts = []
    let attempts = 0

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTagsAndDesc(
      photoIds,
      structuredResult,
      // searchMode == 'curation' ? 'low_precision' : searchMode,
      searchMode,
      userId?.toString()
    )

    do {
      const { paginatedPhotos, hasMore } = await this.getPaginatedPhotosByPage(
        embeddingScoredPhotos,
        pageSize,
        iteration
      )

      yield {
        type: searchMode !== 'curation' ? 'search-matches' : 'curation-matches',
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

      if (searchMode !== 'curation') {
        return
      }

      const batchSize = 1

      let photoBatches = []
      for (let i = 0; i < paginatedPhotos.length; i += batchSize) {
        photoBatches.push(paginatedPhotos.slice(i, i + batchSize))
      }

      const batchPromises = photoBatches.map(async (batch, index) => {
        const { modelResult, modelCost } = await this.processBatchInsightsImage(
          batch,
          structuredResult,
          searchMode
        )

        modelCosts.push(modelCost)

        return batch.map((scoredPhoto, idx) => {
          const result = modelResult[idx]
          const reasoning = result?.reasoning || ''
          const matchScore = result?.matchScore

          return {
            ...scoredPhoto,
            score: scoredPhoto.tagScore || scoredPhoto.score,
            matchScore,
            reasoning,
          }
        })
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
          finished: !(
            attempts < maxPageAttempts &&
            photosResult.filter((p) => p.matchScore >= minMatchScore).length === 0
          ),
          cost: { expansionCost, modelCosts },
          iteration: iteration - 1,
          structuredResult,
          requireSource: { useImage },
        },
      }

      if (attempts >= maxPageAttempts || paginatedPhotos.length === 0) {
        yield {
          type: 'maxPageAttempts',
        }
        return
      }

      await this.sleep(750)
    } while (
      attempts < maxPageAttempts &&
      photosResult.filter((p) => p.matchScore >= minMatchScore).length < minResults
    )
  }

  /**
   * Versión síncrona/paginada de searchSemantic, sin soporte para 'curation'.
   * Devuelve solo la página correspondiente a la iteración solicitada.
   */
  public async searchSemanticSync(
    query: string,
    userId: string | number,
    options: SearchOptions = {
      searchMode: 'logical',
      pageSize: 18,
      iteration: 1,
    }
  ) {
    const {
      searchMode = 'logical',
      pageSize = 18,
      iteration = 1,
      collections,
      visualAspects,
      artisticScores,
    } = options

    if (searchMode === 'curation') {
      throw new Error('searchSemanticSync no soporta el modo curation')
    }

    const photoIds = await this.photoManager.getPhotosIdsForSearch(
      userId?.toString(),
      collections && collections.length > 0 ? collections : undefined,
      visualAspects && visualAspects.length > 0 ? visualAspects : undefined,
      artisticScores && artisticScores.length > 0 ? artisticScores : undefined
    )

    const { structuredResult, useImage, expansionCost } = await this.queryService.structureQuery(
      query,
      searchMode
    )

    const embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTagsAndDesc(
      photoIds,
      structuredResult,
      searchMode,
      userId?.toString()
    )

    const { paginatedPhotos, hasMore } = await this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      iteration
    )

    return {
      type: 'search-matches',
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
  }

  public async searchByTagsSync(options: SearchTagsOptions, userId: string | number) {
    const { included, excluded, iteration, pageSize, searchMode, collections, visualAspects } =
      options

    const photoIds = await this.photoManager.getPhotosIdsForSearch(
      userId?.toString(),
      collections && collections.length > 0 ? collections : undefined,
      visualAspects && visualAspects.length > 0 ? visualAspects : undefined
    )

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTags(
      photoIds,
      included,
      excluded,
      searchMode,
      userId?.toString()
    )

    const { paginatedPhotos, hasMore } = await this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      iteration
    )

    return {
      type: 'search-matches',
      data: {
        hasMore,
        results: {
          [iteration]: paginatedPhotos,
        },
        iteration: iteration,
      },
    }
  }

  public async searchTopologicalSync(
    query: any,
    userId: string | number,
    options: SearchTopologicalOptions
  ) {
    const { pageSize, iteration, searchMode, collections, visualAspects } = options

    const photoIds = await this.photoManager.getPhotosIdsForSearch(
      userId?.toString(),
      collections && collections.length > 0 ? collections : undefined,
      visualAspects && visualAspects.length > 0 ? visualAspects : undefined
    )

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTopoAreas(
      photoIds,
      {
        left: options.left,
        right: options.right,
        middle: options.middle,
      },
      searchMode,
      userId?.toString()
    )

    const { paginatedPhotos, hasMore } = await this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      iteration
    )

    return {
      type: 'search-matches',
      data: {
        hasMore,
        results: {
          [iteration]: paginatedPhotos,
        },
        iteration: iteration,
      },
    }
  }

  public async processBatchInsightsImage(
    batch: any[],
    structuredResult: any,
    searchMode: SearchMode
  ) {
    const searchModelMessage = MESSAGE_SEARCH_MODEL_CREATIVE_SCORED_IMAGE

    const imagesPayload = await this.generateImagesPayload(batch.map((cp) => cp.photo))

    const defaultResults = batch.map(() => ({
      matchScore: null,
      reasoning: null,
    }))

    let modelResult = []
    let modelCost = 0

    if (imagesPayload.length) {
      const response = await this.modelsService.getGeminiResponse(
        searchModelMessage(),
        [
          {
            type: 'text',
            text: JSON.stringify({ query: structuredResult.original }),
          },
          ...imagesPayload,
        ],
        'gemini-2.0-flash',
        {
          temperature: 0.7,
          mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
        },
        false
        // null,
        // 0.7,
        // false
      )

      modelResult = response.result || []
      modelCost = response.cost || 0
    }

    const combinedResults = defaultResults.map((defaultResult, i) => ({
      ...defaultResult,
      ...modelResult[i],
    }))

    return {
      modelResult: combinedResults,
      modelCost,
    }
  }

  //   public async processBatchInsightsDesc(
  //   batch: any[],
  //   structuredResult: any,
  //   searchMode: SearchMode
  // ) {
  //   const searchModelMessage =
  //     searchMode == 'curation' ? MESSAGE_SEARCH_MODEL_CREATIVE(true) : MESSAGE_SEARCH_MODEL_STRICT()
  //   const photosWithChunks = []
  //   const defaultResultsMap: { [key: string]: any } = {}

  //   // Prellenamos defaultResultsMap para todas las fotos
  //   for (const batchedPhoto of batch) {
  //     defaultResultsMap[batchedPhoto.photo.tempID] = {
  //       id: batchedPhoto.photo.tempID,
  //       isInsight: false,
  //       reasoning: null,
  //     }
  //   }

  //   // Procesamos cada foto: si se obtienen chunks se añaden a la colección para el modelo
  //   for (const batchedPhoto of batch) {
  //     const descChunks = await this.scoringService.getNearChunksFromDesc(
  //       batchedPhoto.photo,
  //       structuredResult.no_prefix,
  //       0.1
  //     )
  //     const chunkedDesc = descChunks.map((dc) => dc.text_chunk).join(' ... ')
  //     if (chunkedDesc) {
  //       photosWithChunks.push({
  //         id: batchedPhoto.photo.tempID,
  //         description: chunkedDesc,
  //         visual_accents: batchedPhoto.photo.descriptions.visual_accents,
  //       })
  //     }
  //   }

  //   // Llamamos al modelo con las fotos que tienen chunks
  //   let modelResponse
  //   if (photosWithChunks.length) {
  //     modelResponse = await this.modelsService.getGPTResponse(
  //       searchModelMessage,
  //       JSON.stringify({
  //         query: structuredResult.original,
  //         collection: photosWithChunks,
  //       }),
  //       'gpt-4o', //deepseek-chat
  //       null,
  //       1.1,
  //       false
  //     )
  //   }

  //   // Sobreescribimos defaultResultsMap con los resultados que devuelve el modelo
  //   const modelResults = modelResponse ? modelResponse.result : []
  //   for (const result of modelResults) {
  //     defaultResultsMap[result.id] = result
  //   }

  //   const combinedResults = batch.map(
  //     (batchedPhoto) => defaultResultsMap[batchedPhoto.photo.tempID]
  //   )

  //   return {
  //     modelResult: combinedResults,
  //     modelCost: modelResponse ? modelResponse.cost : 0,
  //   }
  // }

  // AUXILIARES //

  private async getPaginatedPhotosByPage(embeddingScoredPhotos, pageSize, currentIteration) {
    const offset = (currentIteration - 1) * pageSize
    const pageSlice = embeddingScoredPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < embeddingScoredPhotos.length

    const pagePhotoModels = await Photo.query()
      .whereIn(
        'id',
        pageSlice.map((p) => p.id)
      )
      .preload('tags', (q) => q.preload('tag'))
    const photoMap = new Map(pagePhotoModels.map((p) => [p.id, p]))

    const paginatedPhotos = pageSlice.map((scoredPhoto) => {
      const photo = photoMap.get(scoredPhoto.id)
      return {
        photo: {
          id: photo.id,
          thumbnailName: photo.thumbnailName,
          name: photo.name,
          descriptions: photo?.descriptions,
          tags: photo?.tags,
          originalUrl: photo?.originalUrl,
          thumbnailUrl: photo?.thumbnailUrl,
          ...scoredPhoto,
          //matchingTags: scoredPhoto.matchingTags ? scoredPhoto.matchingTags.map((t) => t.name) : [],
        },
      }
    })

    return { hasMore, paginatedPhotos }
  }

  public async generateImagesPayload(photos: Photo[]) {
    const validImages: any[] = []

    for (const photo of photos) {
      try {
        const base64 = await PhotoImageService.getInstance().getImageBase64FromR2(photo.name, false)

        validImages.push({
          base64,
        })
      } catch (error) {
        console.warn(`No se pudo obtener la imagen ${photo.name} desde R2`, error)
      }
    }

    const payload = validImages.map(({ base64 }) => ({
      inlineData: {
        mimeType: 'image/png',
        data: base64,
      },
    }))

    // Limpiar validImages para liberar memoria
    validImages.forEach((img) => (img.base64 = ''))
    validImages.length = 0

    return payload
    // return validImages.map(({ base64 }) => ({
    //   type: 'image_url',
    //   image_url: {
    //     url: `data:image/jpeg;base64,${base64}`,
    //     detail: 'low',
    //   },
    // }))
  }
}
