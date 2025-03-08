// @ts-nocheck

import Photo from '#models/photo'
import Tag from '#models/tag'
import fs from 'fs/promises'

import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import EmbeddingsService from './embeddings_service.js'
import AnalyzerService from './analyzer_service.js'
import withCost from '../decorators/withCost.js'
import QueryService from './query_service.js'
import withCostWS from '../decorators/withCostWs.js'
import ScoringService from './scoring_service.js'
import { withCache } from '../decorators/withCache.js'
import {
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
} from '../utils/ModelsMessages.js'

export default class PhotosService {
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public analyzerService: AnalyzerService = null
  public queryService: QueryService = null
  public scoringService: ScoringService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.analyzerService = new AnalyzerService()
    this.queryService = new QueryService()
    this.scoringService = new ScoringService()
  }

  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async updatePhoto(id: string, updates: Partial<Photo>) {
    const photo = await Photo.find(id)
    if (!photo) {
      throw new Error('Photo not found')
    }

    // Inicializa 'processed' si es null o undefined
    photo.processed = photo.processed || {
      context: false,
      story: false,
      topology: false,
      artistic: false,
      tags: false,
    }

    if (updates.descriptions && typeof updates.descriptions === 'object') {
      photo.descriptions = {
        ...(photo.descriptions || {}),
        ...updates.descriptions,
      }
    }

    if (updates.processed && typeof updates.processed === 'object') {
      photo.processed = {
        ...photo.processed,
        ...updates.processed,
      }
    }

    Object.entries(updates).forEach(([key, value]) => {
      if (key !== 'descriptions' && key !== 'processed') {
        ;(photo as any)[key] = value
      }
    })

    await photo.save()
    return photo
  }

  @withCache({
    key: (arg1) => `getPhotosByUser_${arg1}`,
    provider: 'redis',
    ttl: 50 * 5,
  })
  public async getPhotosByUser(userId: string[]) {
    let photos = await Photo.query().preload('tags').preload('descriptionChunks')
    return photos.map((photo) => ({
      ...photo.$attributes,
      tags: photo.tags,
      descriptionChunks: photo.descriptionChunks,
      description: photo.description,
      tempID: Math.random().toString(36).substr(2, 4),
    }))
  }

  // TODO: todo esto a search_service.ts

  public async *searchByTags(query: any, options = { deepSearch: false, pageSize: 8 }) {
    const { deepSearch, pageSize } = options
    const photos = await this.getPhotosByUser('1234')

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTags(
      photos,
      query.included,
      query.excluded,
      deepSearch
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

  @withCostWS
  public async *search(
    query: any,
    searchType: 'semantic' | 'creative',
    options = { deepSearch: false, withInsights: false, pageSize: 18 }
  ) {
    const { deepSearch, withInsights } = options
    const photos = await this.getPhotosByUser('1234')

    const { structuredResult, sourceResult, useImage, expansionCost } =
      await this.queryService.structureQueryLLM(searchType, query)

    const batchSize = 3
    const maxPageAttempts = 3

    let photosResult = []
    let modelCosts = []
    let attempts = 0

    let embeddingScoredPhotos = await this.scoringService.getScoredPhotosByTagsAndDesc(
      photos,
      structuredResult,
      searchType,
      deepSearch
    )

    do {
      const { paginatedPhotos, hasMore } = this.getPaginatedPhotosByPage(
        embeddingScoredPhotos,
        query.pageSize,
        query.iteration
      )

      yield {
        type: 'matches',
        data: {
          hasMore,
          results: {
            [query.iteration]: paginatedPhotos,
          },
          cost: { expansionCost },
          iteration: query.iteration,
          structuredResult,
        },
      }

      // Salvo que queramos procesar con IA los insights, ya tenemos el resultado de esta página
      if (!withInsights) {
        return
      }

      let photoBatches = []
      for (let i = 0; i < paginatedPhotos.length; i += batchSize) {
        photoBatches.push(paginatedPhotos.slice(i, i + batchSize))
      }

      const batchPromises = photoBatches.map(async (batch) => {
        const { modelResult, modelCost } = await this.processBatch(
          batch,
          structuredResult,
          sourceResult,
          searchType,
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

      query.iteration++
      attempts++

      yield {
        type: 'insights',
        data: {
          results: { [query.iteration - 1]: photosResult },
          hasMore,
          cost: { expansionCost, modelCosts },
          iteration: query.iteration - 1,
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
    searchType: 'semantic' | 'creative',
    paginatedPhotos: any[]
  ) {
    let searchModelMessage
    if (searchType === 'creative' || searchType === 'semantic') {
      searchModelMessage =
        sourceResult.requireSource === 'image'
          ? SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
          : SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
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
        searchType === 'creative' ? 1.1 : 0.5,
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
