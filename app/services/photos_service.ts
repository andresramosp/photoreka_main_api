// @ts-nocheck

import Photo from '#models/photo'
import Tag from '#models/tag'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_ENRICHMENT,
  SYSTEM_MESSAGE_QUERY_ENRICHMENT_CREATIVE,
  SYSTEM_MESSAGE_QUERY_ENRICHMENT_V2,
  SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE,
  SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_MODEL_IMG,
  SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_MODEL_V3,
  SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4,
  SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
} from '../utils/GPTMessages.js'
import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import EmbeddingsService from './embeddings_service.js'
import AnalyzerService from './analyzer_service.js'
import withCost from '../decorators/withCost.js'

export default class PhotosService {
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public analyzerService: AnalyzerService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.analyzerService = new AnalyzerService()
  }

  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async filterByTags(tagsAnd: any[][], tagsNot: any[], tagsOr: any[]): Promise<any[]> {
    if (tagsOr.length) {
      tagsAnd.push(tagsOr.flat())
    }

    // Construcción de la query base
    const query = Photo.query().preload('tags')

    if (tagsAnd.length > 0) {
      for (const tagGroup of tagsAnd) {
        query.whereHas('tags', (tagQuery) => {
          tagQuery.whereIn(
            'name',
            tagGroup.map((tag) => tag.tag)
          )
        })
      }
    }

    // Exclusión de tags NOT
    if (tagsNot.length > 0) {
      query.whereDoesntHave('tags', (tagQuery) => {
        tagQuery.whereIn(
          'name',
          tagsNot.map((tag) => tag.tag)
        )
      })
    }

    // Ejecutar la consulta
    const photos = await query.exec()

    // Agregar matchingTags manualmente después de la consulta
    return photos.map((photo) => {
      const matchingTags = photo.tags
        .filter((tag) => tagsAnd.flat().some((andTag) => andTag.tag === tag.name))
        .map((tag) => tag.name)

      return { ...photo.toJSON(), matchingTags }
    })
  }

  public async saveExpandedTags(term: any, tags: any[], expansionResults: any) {
    const modelsService = new ModelsService()

    try {
      const similarTags = await this.modelsService.getSynonymTags(
        term.tagName,
        tags.map((tag) => tag.name)
      )
      if (similarTags.length) {
        similarTags.forEach(async (similarTag) => {
          const tagInDB = tags.find((t) => t.name === similarTag)
          if (tagInDB) {
            const existingChildren = [...(tagInDB.children?.length ? tagInDB.children : [])]

            const mergedChildren = [...existingChildren, ...expansionResults[term.tagName]].reduce(
              (acc, item) => {
                acc[item.tag] = { ...acc[item.tag], ...item }
                return acc
              },
              {}
            )
            tagInDB.children = {
              tags: Object.values(mergedChildren),
            }
            tagInDB.save()
            console.log(
              `Saved children for existing tag ${tagInDB.name}: ${JSON.stringify(tagInDB.children.tags.map((tag: any) => tag.tag))}`
            )
          }
        })
      }

      // Create a new tag only if the term itself is not found in similar tags
      if (!similarTags.includes(term.tagName)) {
        const newTag = new Tag()
        const { embeddings } = await this.modelsService.getEmbeddings([term.tagName])
        newTag.embedding = embeddings[0]
        newTag.name = term.tagName
        newTag.children = { tags: expansionResults[term.tagName] }
        newTag.save()
        console.log(
          `Saved children for new tag ${newTag.name}: ${JSON.stringify(newTag.children.tags.map((tag: any) => tag.tag))}`
        )
      }
    } catch (err) {
      console.error('Error guardando expansores')
    }
  }

  public async performTagsExpansion(terms: any[], allTags: any[]) {
    let expansionResults: any = {}
    const expansionCosts: any[] = []

    await Promise.all(
      terms.map(async (term) => {
        let existingTag = allTags.find((tag) => tag.name === term.tagName)
        if (!existingTag) {
          const semanticallyCloseTags = await this.embeddingsService.findSimilarTagsToText(
            term.tagName,
            0.9,
            1
          )
          if (semanticallyCloseTags.length)
            console.log(
              `Found semantically close tag ${semanticallyCloseTags[0].name} for ${term.tagName}`
            )
          existingTag = semanticallyCloseTags[0]
        }

        if (existingTag && existingTag.children?.tags.length) {
          expansionResults[term.tagName] = existingTag.children.tags || []
          console.log(
            `Using stored expansors for ${term.tagName}: ${JSON.stringify(existingTag.children.tags.map((t: any) => t.tag))} `
          )
        } else {
          const nearTags = await this.embeddingsService.findSimilarTagsToText(term.tagName, 0.4, 30)
          const { result, cost } = await this.modelsService.getDSResponse(
            term.isAction
              ? SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4
              : SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
            JSON.stringify({
              // operation: 'semanticSubExpansion',
              term: term.tagName,
              tagCollection: nearTags.map((tag: any) => tag.name),
            }),
            'deepseek-chat',
            null
          )

          // Recuperamos la proximidad semántica
          if (result.length) {
            for (let tag of result) {
              tag.proximity = nearTags.find((nearTag: any) => nearTag.name == tag.tag)?.proximity
            }
            expansionResults[term.tagName] = result.filter((tag: any) => tag.isSubclass)
          } else {
            expansionResults[term.tagName] = []
          }

          expansionCosts.push(cost)
          this.saveExpandedTags(term, allTags, expansionResults)
        }
      })
    )

    return { expansionResults, expansionCosts }
  }

  @withCost
  public async searchByTags(query: any): Promise<any> {
    const allTags = await Tag.all()
    let cost1
    let queryLogicResult

    // Step 1: Perform initial logic query
    const { result, cost } = await this.modelsService.getDSResponse(
      SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
      JSON.stringify({
        query: query.description,
      })
    )
    queryLogicResult = result
    cost1 = cost

    if (result === 'NON_TAGGABLE') {
      return { queryLogicResult }
    }

    // Step 2: Extract and expand terms
    const terms = [
      ...queryLogicResult.tags_and,
      ...queryLogicResult.tags_not,
      ...queryLogicResult.tags_or,
    ]

    const { expansionResults, expansionCosts } = await this.performTagsExpansion(terms, allTags)

    // Step 3: Precompute all expansions and initialize tracking
    const precomputedIterations: Record<string, any[]> = {}
    const usedPrecomputedIterations: Record<string, any[]> = {}
    const expansorsPerIteration = 2

    queryLogicResult.tags_and.forEach((tag: any) => {
      const expandedTerms = expansionResults[tag.tagName]
      precomputedIterations[tag.tagName] = [...expandedTerms]
      usedPrecomputedIterations[tag.tagName] = [...expandedTerms.slice(0, 0)]
    })

    queryLogicResult.tags_or.forEach((tag: any) => {
      const expandedTerms = expansionResults[tag.tagName]
      precomputedIterations[tag.tagName] = [...expandedTerms]
      usedPrecomputedIterations[tag.tagName] = [...expandedTerms.slice(0, 0)]
    })

    queryLogicResult.tags_not.forEach((tag: any) => {
      const expandedTerms = expansionResults[tag.tagName]
      precomputedIterations[tag.tagName] = [...expandedTerms]
      usedPrecomputedIterations[tag.tagName] = [...expandedTerms.slice(0, 0)]
    })

    // Perform filtering while tracking used terms
    let results: Record<number, any> = {}
    let seenPhotoIds = new Set<number>()
    let iteration = 1

    while (
      Object.keys(precomputedIterations).some(
        (key) => usedPrecomputedIterations[key].length < precomputedIterations[key].length
      )
    ) {
      const tagsAnd = queryLogicResult.tags_and.map((tag: any) => {
        const remainingTerms = precomputedIterations[tag.tagName].slice(
          usedPrecomputedIterations[tag.tagName].length,
          usedPrecomputedIterations[tag.tagName].length + expansorsPerIteration
        )
        usedPrecomputedIterations[tag.tagName].push(...remainingTerms)
        return [{ tag: tag.tagName }, ...usedPrecomputedIterations[tag.tagName]]
      })

      const tagsOr = queryLogicResult.tags_or.map((tag: any) => {
        const remainingTerms = precomputedIterations[tag.tagName].slice(
          usedPrecomputedIterations[tag.tagName].length,
          usedPrecomputedIterations[tag.tagName].length + expansorsPerIteration
        )
        usedPrecomputedIterations[tag.tagName].push(...remainingTerms)
        return [{ tag: tag.tagName }, ...usedPrecomputedIterations[tag.tagName]]
      })

      const tagsNot = queryLogicResult.tags_not
        .map((tag: any) => {
          const allTerms = precomputedIterations[tag.tagName]
          precomputedIterations[tag.tagName] = []
          return [{ tag: tag.tagName }, ...allTerms]
        })
        .flat()

      let filteredPhotos = await this.filterByTags([...tagsAnd], [...tagsNot], [...tagsOr])

      filteredPhotos = filteredPhotos.filter((photo: any) => {
        if (seenPhotoIds.has(photo.id)) {
          return false
        }
        seenPhotoIds.add(photo.id)
        return true
      })

      if (filteredPhotos.length) {
        results[iteration] = {
          photos: filteredPhotos,
          tagsAnd,
          tagsNot,
          tagsOr,
        }
      }

      iteration++
    }

    // Step 4: Return precomputed expansions and iteration results
    return {
      results,
      cost: { queryToLogic: cost1, expansionCosts },
      queryLogicResult,
    }
  }

  public generateTempID(): string {
    return Math.random().toString(36).substr(2, 4)
  }

  public async processQuery(type: 'semantic' | 'creative', query) {
    const enrichmentMessage =
      type === 'semantic' ? SYSTEM_MESSAGE_QUERY_ENRICHMENT : SYSTEM_MESSAGE_QUERY_ENRICHMENT

    const sourceMessage = SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE

    // Ejecutamos las llamadas en paralelo
    const [enrichmentResponse, sourceResponse] = await Promise.all([
      this.modelsService.getDSResponse(
        enrichmentMessage,
        JSON.stringify({ query: query.description })
      ),
      this.modelsService.getDSResponse(sourceMessage, JSON.stringify({ query: query.description })),
    ])

    const { result: enrichmentResult, cost: cost1 } = enrichmentResponse
    const { result: sourceResult, cost: cost2 } = sourceResponse

    let useImage = sourceResult.requireSource !== 'description' // de momento both usa solo imagen, parece que tiene en cuenta la parte descriptiva

    const searchModelMessage =
      type === 'semantic'
        ? !useImage
          ? SYSTEM_MESSAGE_SEARCH_MODEL_V3
          : SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE
        : !useImage
          ? SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
          : SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE

    return { searchModelMessage, sourceResult, useImage, enrichmentResult, cost1, cost2 }
  }

  public async handleEmbeddingsOnly(query: any, enrichmentResult: any, nearPhotos: any[]) {
    return {
      results: {
        [query.iteration]: {
          photos: nearPhotos?.slice(0, 100)?.map((item) => item.photo),
        },
      },
      iteration: query.iteration,
      enrichmentQuery: enrichmentResult.query,
      scores: nearPhotos?.slice(0, 100),
    }
  }

  public async processBatch(
    batch: any[],
    enrichmentQuery: string,
    originalQuery: string,
    searchModelMessage: any,
    needImage: boolean,
    type: 'semantic' | 'creative',
    paginatedPhotos: any[]
  ) {
    const method = !needImage ? 'getDSResponse' : 'getGPTResponse'
    const { result: modelResult, cost: modelCost } = await this.modelsService[method](
      !needImage ? searchModelMessage : searchModelMessage(batch.map((cp) => cp.tempID)),
      !needImage
        ? JSON.stringify({
            query: originalQuery,
            collection: batch.map((item) => ({
              id: item.photo.tempID,
              description: item.photo.description,
            })),
          })
        : [
            {
              type: 'text',
              text: JSON.stringify({ query: originalQuery }),
            },
            ...(await this.generateImagesPayload(
              paginatedPhotos.map((pp) => pp.photo),
              batch.map((cp) => cp.id)
            )),
          ],
      !needImage ? 'deepseek-chat' : 'gpt-4o-mini',
      null,
      type === 'creative' ? 1.3 : 0.4,
      false
    )

    return {
      modelResult,
      modelCost,
    }
  }

  @withCost
  public async search(
    query: any,
    type: 'semantic' | 'creative',
    options = { embeddingsOnly: false }
  ) {
    const pageSize = 8
    const batchSize = 4
    const maxPageAttempts = 3

    let photosResult = []
    let modelCosts = []
    let attempts = 0
    let hasMore

    const { embeddingsOnly } = options
    const photos = (await Photo.query().preload('tags').preload('descriptionChunks')).map(
      (photo) => ({
        ...photo.$attributes,
        tags: photo.tags,
        descriptionChunks: photo.descriptionChunks,
        tempID: this.generateTempID(),
      })
    )

    const {
      enrichmentResult,
      sourceResult,
      useImage,
      searchModelMessage,
      cost1: enrichmentCost,
      cost2: sourceCost,
    } = await this.processQuery(type, query)

    const nearPhotos = await this.embeddingsService.getSemanticScoredPhotos(
      photos,
      enrichmentResult.query
      // query.description
    )

    if (embeddingsOnly) {
      return this.handleEmbeddingsOnly(query, enrichmentResult, nearPhotos)
    }

    do {
      const offset = (query.iteration - 1) * pageSize
      const paginatedPhotos = nearPhotos.slice(offset, offset + pageSize)
      hasMore = offset + pageSize < nearPhotos.length

      if (attempts >= maxPageAttempts || paginatedPhotos.length === 0) {
        break
      }

      const photoBatches = []
      for (let i = 0; i < paginatedPhotos.length; i += batchSize) {
        photoBatches.push(paginatedPhotos.slice(i, i + batchSize))
      }

      const batchPromises = photoBatches.map(async (batch) => {
        const { modelResult, modelCost } = await this.processBatch(
          batch,
          enrichmentResult.query,
          query.description,
          searchModelMessage,
          useImage,
          type,
          paginatedPhotos
        )

        modelCosts.push(modelCost)

        return batch
          .map((item) => {
            const reasoning = modelResult.find((res) => res.id === item.photo.tempID)?.reasoning
            return reasoning
              ? { ...item.photo, score: item.tagScore, reasoning }
              : { ...item.photo, score: item.tagScore }
          })
          .filter((item) => modelResult.find((res) => res.id === item.tempID)) // && res.isIncluded))
      })

      const batchResults = await Promise.all(batchPromises)
      photosResult = photosResult.concat(...batchResults)

      query.iteration++
      attempts++
    } while (!photosResult.length)

    return {
      results: { [query.iteration]: { photos: photosResult } },
      hasMore: hasMore && attempts < maxPageAttempts,
      cost: { enrichmentCost, sourceCost, modelCosts },
      iteration: query.iteration,
      enrichmentQuery: enrichmentResult.query,
      requireSource: { source: sourceResult.requireSource, useImage },
    }
  }

  public async getNearChunksFromDesc(photo: Photo, query: string) {
    if (!photo.descriptionChunks.length) {
      await this.analyzerService.processDesc(photo.description, photo.id)
    }
    const similarChunks = await this.embeddingsService.findSimilarChunksToText(
      query,
      0,
      5,
      'cosine_similarity',
      photo
    )
    return similarChunks.map((ch) => {
      return { proximity: ch.proximity, text_chunk: ch.chunk }
    })
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
          .resize({ width: 1012, fit: 'inside' })
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
