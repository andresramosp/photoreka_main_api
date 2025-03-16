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
import {
  MESSAGE_SEARCH_MODEL_CREATIVE,
  MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
} from '../utils/ModelsMessages.js'
import PhotosService from './photos_service.js'

export type SearchMode = 'logical' | 'creative'
export type SearchType = 'semantic' | 'tags' | 'topological'

export type SearchOptions = {
  searchMode: SearchMode
  withInsights?: boolean
  iteration: number
  pageSize: number
}

export default class SearchService {
  public modelsService: ModelsService = null
  public photosService: PhotosService = null
  public queryService: QueryService = null
  public scoringService: ScoringService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.photosService = new PhotosService()
    this.queryService = new QueryService()
    this.scoringService = new ScoringService()
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
    const photos = await this.photosService.getPhotosByUser('1234')

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

      const batchSize = 3
      const maxPageAttempts = 3

      let photoBatches = []
      for (let i = 0; i < paginatedPhotos.length; i += batchSize) {
        photoBatches.push(paginatedPhotos.slice(i, i + batchSize))
      }

      const batchPromises = photoBatches.map(async (batch) => {
        const { modelResult, modelCost } = await this.processBatch(
          batch,
          structuredResult,
          sourceResult,
          searchMode,
          paginatedPhotos
        )

        modelCosts.push(modelCost)

        return batch
          .map((item) => {
            const result = modelResult.find((res) => res.id === item.photo.tempID)
            const reasoning = result?.reasoning || ''
            const isIncluded =
              result?.isIncluded == true || result?.isIncluded == 'true' ? true : false

            return reasoning
              ? { photo: item.photo, score: item.tagScore, isIncluded, reasoning }
              : { photo: item.photo, score: item.tagScore, isIncluded }
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
    } while (!photosResult.some((p) => p.isIncluded))
  }

  //   @withCostWS
  public async *searchByTags(query: any, options: SearchOptions) {
    const { pageSize } = options
    const photos = await this.getPhotosByUser('1234')

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTags(
      photos,
      query.included,
      query.excluded
    )

    const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      query.iteration
    )

    yield {
      type: 'matches',
      data: {
        hasMore,
        results: {
          [query.iteration]: paginatedPhotos,
        },
        iteration: query.iteration,
      },
    }
  }

  //   @withCostWS
  public async *searchTopological(query: any, options: SearchOptions) {
    const { pageSize } = options
    const photos = await this.getPhotosByUser('1234')

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTags(
      photos,
      query.included,
      query.excluded
    )

    const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
      embeddingScoredPhotos,
      pageSize,
      query.iteration
    )

    yield {
      type: 'matches',
      data: {
        hasMore,
        results: {
          [query.iteration]: paginatedPhotos,
        },
        iteration: query.iteration,
      },
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

  public async processBatch(
    batch: any[],
    structuredResult: any,
    sourceResult: any,
    searchMode: SearchMode,
    paginatedPhotos: any[]
  ) {
    let searchModelMessage

    if (searchMode === 'creative' || searchMode === 'semantic') {
      searchModelMessage =
        sourceResult.requireSource === 'image'
          ? MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
          : MESSAGE_SEARCH_MODEL_CREATIVE(true)
    }

    let needImage = sourceResult.requireSource == 'image'
    const method = 'getGPTResponse' // !needImage ? 'getDSResponse' : 'getGPTResponse'
    let chunkPromises = batch.map(async (batchedPhoto) => {
      const descChunks = await this.scoringService.getNearChunksFromDesc(
        batchedPhoto.photo,
        structuredResult.no_prefix,
        0.1
      )
      return {
        tempID: batchedPhoto.photo.tempID,
        chunkedDesc: descChunks.map((dc) => dc.text_chunk).join(' ... '),
      }
    })
    let chunkResults = await Promise.all(chunkPromises)
    chunkResults = chunkResults.filter((cp) => cp.chunkedDesc)
    if (chunkResults.length) {
      const { result: modelResult, cost: modelCost } = await this.modelsService[method](
        !needImage ? searchModelMessage : searchModelMessage(chunkResults.map((cp) => cp.tempID)),
        !needImage
          ? JSON.stringify({
              query: structuredResult.original,
              collection: chunkResults.map((chunkedPhoto) => ({
                id: chunkedPhoto.tempID,
                description: chunkedPhoto.chunkedDesc,
                tags: undefined,
              })),
            })
          : [
              {
                type: 'text',
                text: JSON.stringify({ query: structuredResult.original }),
              },
              ...(await this.generateImagesPayload(
                paginatedPhotos.map((pp) => pp.photo),
                batch.map((cp) => cp.photo.id)
              )),
            ],
        method == 'getGPTResponse' ? 'gpt-4o' : 'deepseek-chat',
        null,
        searchMode === 'creative' ? 1.1 : 0.5,
        false
      )

      return {
        modelResult,
        modelCost,
      }
    } else {
      return { modelResult: [], modelCost: 0 }
    }
  }

  public async generateImagesPayload(photos: Photo[], photoIds: string[]) {
    const validImages: any[] = []
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    for (const id of photoIds) {
      const photo = photos.find((photo) => photo.id == id)
      if (!photo) continue

      const filePath = path.join(uploadPath, `${photo.name}`)

      try {
        await fs.access(filePath)

        const resizedBuffer = await sharp(filePath)
          // .resize({ width: 1012, fit: 'inside' })
          .toBuffer()

        validImages.push({
          id: photo.id,
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
