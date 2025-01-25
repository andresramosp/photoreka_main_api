// @ts-nocheck

import Photo from '#models/photo'
import Tag from '#models/tag'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_ENRICHMENT,
  SYSTEM_MESSAGE_QUERY_ENRICHMENT_CREATIVE,
  SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE,
  SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_MODEL_IMG,
  SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_SEMANTIC,
  SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL,
  SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL_v2,
  SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4,
  SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
} from '../utils/ModelsMessages.js'
import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import EmbeddingsService from './embeddings_service.js'
import AnalyzerService from './analyzer_service.js'
import withCost from '../decorators/withCost.js'
import QueryService from './query_service.js'

export default class PhotosService {
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public analyzerService: AnalyzerService = null
  public queryService: QueryService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.analyzerService = new AnalyzerService()
    this.queryService = new QueryService()
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

  public async performTagsExpansion(terms: any[], allTags: any[], useModel: boolean = true) {
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

        if (false) {
          // (existingTag && existingTag.children?.tags.length) {
          expansionResults[term.tagName] = existingTag.children.tags || []
          console.log(
            `Using stored expansors for ${term.tagName}: ${JSON.stringify(existingTag.children.tags.map((t: any) => t.tag))} `
          )
        } else {
          const nearTags = await this.embeddingsService.findSimilarTagsToText(term.tagName, 0.4, 30)
          if (useModel) {
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
          } else {
            expansionResults[term.tagName] = nearTags.map((tag) => {
              return { tag: tag.name }
            })
          }
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

    const { expansionResults, expansionCosts } = await this.performTagsExpansion(
      terms,
      allTags,
      false
    )

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

  public async processBatch(
    batch: any[],
    enrichmentResult: any,
    searchModelMessage: any,
    needImage: boolean,
    searchType: 'semantic' | 'creative',
    paginatedPhotos: any[]
  ) {
    const method = !needImage ? 'getDSResponse' : 'getGPTResponse'
    let chunkPromises = batch.map(async (batchedPhoto) => {
      if (enrichmentResult.type == 'logical') {
        const similarTags = await this.queryService.getTagsForLogicalQuery(
          batchedPhoto.photo,
          enrichmentResult.enriched
        )
        return {
          tempID: batchedPhoto.photo.tempID,
          tags: similarTags.map((nt) => nt.name),
        }
      } else {
        const descChunks = await this.embeddingsService.getNearChunksFromDesc(
          batchedPhoto.photo,
          enrichmentResult.enriched,
          0.1
        )
        return {
          tempID: batchedPhoto.photo.tempID,
          chunkedDesc: descChunks.map((dc) => dc.text_chunk).join(' ... '),
        }
      }
    })
    let chunkResults = await Promise.all(chunkPromises)
    const { result: modelResult, cost: modelCost } = await this.modelsService[method](
      !needImage ? searchModelMessage : searchModelMessage(chunkResults.map((cp) => cp.tempID)),
      !needImage
        ? JSON.stringify({
            query: enrichmentResult.clear,
            collection: chunkResults.map((chunkedPhoto) => ({
              id: chunkedPhoto.tempID,
              description:
                enrichmentResult.type != 'logical' ? chunkedPhoto.chunkedDesc : undefined,
              tags: enrichmentResult.type == 'logical' ? chunkedPhoto.tags : undefined,
            })),
          })
        : [
            {
              type: 'text',
              text: JSON.stringify({ query: enrichmentResult.clear }),
            },
            ...(await this.generateImagesPayload(
              paginatedPhotos.map((pp) => pp.photo),
              batch.map((cp) => cp.photo.id)
            )),
          ],
      !needImage ? 'deepseek-chat' : 'gpt-4o-mini',
      null,
      searchType === 'creative' ? 1.3 : 0.4,
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
    searchType: 'semantic' | 'creative',
    options = { embeddingsOnly: false }
  ) {
    const { embeddingsOnly } = options
    const photos = (await Photo.query().preload('tags').preload('descriptionChunks')).map(
      (photo) => ({
        ...photo.$attributes,
        tags: photo.tags,
        descriptionChunks: photo.descriptionChunks,
        tempID: Math.random().toString(36).substr(2, 4),
      })
    )

    const {
      enrichmentResult,
      sourceResult,
      useImage,
      searchModelMessage,
      cost1: enrichmentCost,
      cost2: sourceCost,
    } = await this.queryService.processQuery(searchType, query)

    const pageSize = 8
    const batchSize = enrichmentResult.type == 'logical' ? 2 : 4
    const maxPageAttempts = 3

    let photosResult = []
    let modelCosts = []
    let attempts = 0
    let hasMore

    let method =
      enrichmentResult.type == 'logical'
        ? 'getSemanticScoredPhotosLogical'
        : 'getSemanticScoredPhotos'
    const nearPhotos = await this.embeddingsService[method](photos, enrichmentResult.enriched)

    if (embeddingsOnly) {
      return {
        results: {
          [query.iteration]: {
            photos: nearPhotos?.slice(0, 100)?.map((item) => item.photo),
          },
        },
        iteration: query.iteration,
        enrichmentQuery: enrichmentResult.enriched,
        scores: nearPhotos?.slice(0, 100),
      }
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

      const evaluatedBatches = await this.evaluateBatches(
        photoBatches,
        enrichmentResult.clear,
        enrichmentResult.type
      )

      const photosWithoutProcessing = evaluatedBatches
        .flatMap((batch) => batch.filter((batchedPhoto) => !batchedPhoto.photo.requiresProcessing))
        .map((batchedPhotos) => batchedPhotos.photo)

      const filteredBatches = evaluatedBatches
        .map((batch) => batch.filter((batchedPhoto) => batchedPhoto.photo.requiresProcessing))
        .filter((batch) => batch.length)

      const batchPromises = filteredBatches.map(async (batch) => {
        const { modelResult, modelCost } = await this.processBatch(
          batch,
          enrichmentResult,
          searchModelMessage,
          useImage,
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
              ? { ...item.photo, score: item.tagScore, isIncluded, reasoning }
              : { ...item.photo, score: item.tagScore, isIncluded }
          })
          .filter((item) => modelResult.find((res) => res.id === item.tempID))
      })

      const batchResults = await Promise.all(batchPromises)
      photosResult = photosResult.concat(...photosWithoutProcessing, ...batchResults.flat())

      query.iteration++
      attempts++
    } while (!photosResult.length)

    return {
      results: { [query.iteration]: { photos: photosResult } },
      hasMore: hasMore && attempts < maxPageAttempts,
      cost: { enrichmentCost, sourceCost, modelCosts },
      iteration: query.iteration,
      enrichmentResult,
      requireSource: { source: sourceResult.requireSource, useImage },
    }
  }

  public async evaluateBatches(photoBatches, query, queryType) {
    return Promise.all(
      photoBatches.map(async (batch) => {
        const photoPromises = batch.map(async (photoBatch) => {
          if (queryType === 'logical' || queryType == 'vague') {
            const evaluationResult = await this.queryService.evaluateQueryLogic(
              query,
              photoBatch.photo
            )

            if (evaluationResult === null) {
              return { photo: { ...photoBatch.photo, requiresProcessing: true } }
            } else {
              return {
                photo: {
                  ...photoBatch.photo,
                  isIncluded: evaluationResult,
                  reasoning: 'Evaluated directly',
                  requiresProcessing: false,
                },
              }
            }
          } else {
            // For non-logical queries, mark the photo as requiring processing
            return { photo: { ...photoBatch.photo, requiresProcessing: true } }
          }
        })

        const evaluatedPhotos = await Promise.all(photoPromises)

        return evaluatedPhotos // Return the array of evaluated photos for the batch
      })
    )
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
