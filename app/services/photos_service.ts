import Photo from '#models/photo'
import Tag from '#models/tag'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_IMG,
  SYSTEM_MESSAGE_SEARCH_MODEL_V2,
  SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4,
  SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
} from '../utils/GPTMessages.js'
import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import EmbeddingsService from './embeddings_service.js'

export default class PhotosService {
  /**
   * Asociar tags a una foto
   */
  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async filterByTags(tagsAnd: any[][], tagsNot: any[], tagsOr: any[]): Promise<any[]> {
    if (tagsOr.length) {
      tagsAnd.push(tagsOr)
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
      const similarTags = await modelsService.getSynonymTags(
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
              `Saved children for existing tag ${tagInDB.name}: ${JSON.stringify(tagInDB.children)}`
            )
          }
        })
      }

      // Create a new tag only if the term itself is not found in similar tags
      if (!similarTags.includes(term.tagName)) {
        const newTag = new Tag()
        const { embeddings } = await modelsService.getEmbeddings([term.tagName])
        newTag.embedding = embeddings[0]
        newTag.name = term.tagName
        newTag.children = { tags: expansionResults[term.tagName] }
        newTag.save()
        console.log(`Saved children for new tag ${newTag.name}: ${JSON.stringify(newTag.children)}`)
      }
    } catch (err) {
      console.error('Error guardando expansores')
    }
  }

  public async performTagsExpansion(terms: any[], allTags: any[]) {
    let expansionResults: any = {}
    const expansionCosts: any[] = []
    const modelsService = new ModelsService()
    const embeddingsService = new EmbeddingsService()

    await Promise.all(
      terms.map(async (term) => {
        let existingTag = allTags.find((tag) => tag.name === term.tagName)
        if (!existingTag) {
          const semanticallyCloseTags = await embeddingsService.findSimilarTagsToText(
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
          const nearTags = await embeddingsService.findSimilarTagsToText(term.tagName, 0.4, 20)
          const { result, cost } = await modelsService.getDSResponse(
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
              tag.value = nearTags.find((nearTag: any) => nearTag.name == tag.tag)?.value
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

  public async search_gpt_to_tags_v2(query: any): Promise<any> {
    const modelsService = new ModelsService()

    const allTags = await Tag.all()
    let cost1
    let queryLogicResult

    // Step 1: Perform initial logic query
    const { result, cost } = await modelsService.getDSResponse(
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

      const tagsOr = queryLogicResult.tags_or
        .map((tag: any) => {
          const remainingTerms = precomputedIterations[tag.tagName].slice(
            usedPrecomputedIterations[tag.tagName].length,
            usedPrecomputedIterations[tag.tagName].length + expansorsPerIteration
          )
          usedPrecomputedIterations[tag.tagName].push(...remainingTerms)
          return [{ tag: tag.tagName }, ...usedPrecomputedIterations[tag.tagName]]
        })
        .flat()

      const tagsNot = queryLogicResult.tags_not
        .map((tag: any) => {
          const allTerms = precomputedIterations[tag.tagName]
          precomputedIterations[tag.tagName] = []
          return [{ tag: tag.tagName }, ...allTerms]
        })
        .flat()

      let filteredPhotos = await this.filterByTags(tagsAnd, tagsNot, tagsOr)

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
      cost: { cost1, expansionCosts },
      queryLogicResult,
    }
  }

  // TODO: Cambiar a getGPTResponse de modelService, adaptando el regex de parseo
  public async search_desc(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let embeddingsService = new EmbeddingsService()

    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration == 1) {
    } else {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    const nearPhotos = await embeddingsService.getSemanticNearPhotos(photos, query, 30)
    let pageSize = 10
    const offset = (query.iteration - 1) * pageSize
    let paginatedPhotos = nearPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < nearPhotos.length

    if (paginatedPhotos.length === 0) {
      return {
        results: [],
        hasMore,
      }
    }

    const { result: modelResult, cost: cost2 } = await modelsService.getDSResponse(
      SYSTEM_MESSAGE_SEARCH_MODEL_V2,
      JSON.stringify({
        query: this.clearQuery(query.description),
        collection: paginatedPhotos.map((photo, idx) => ({
          id: idx,
          description: photo.chunks.join('... '),
        })),
      }),
      'deepseek-chat',
      null
      // SCHEMA_SEARCH_MODEL_V2
    )

    paginatedPhotos = paginatedPhotos.map((photo, idx) => {
      return { ...photo, reasoning: modelResult.find((res: any) => res.id == idx).reasoning }
    })

    const photosResult = paginatedPhotos.filter((_, idx) =>
      modelResult.find((res: any) => res.id == idx && res.isIncluded)
    )

    // Retornar la respuesta
    return {
      results: photosResult,
      hasMore,
      cost: cost2,
    }
  }

  public async search_creative(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let embeddingsService = new EmbeddingsService()
    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration == 1) {
    } else {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    // TODO: añadir llamada LLM para adensar query si es demasiado sucinta ("photos of vegetation"), y quitar "fotos de..."
    const nearPhotos = await embeddingsService.getSemanticNearPhotos(photos, query, 30, 20)
    let pageSize = 5
    const offset = (query.iteration - 1) * pageSize
    let paginatedPhotos = nearPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < nearPhotos.length

    if (paginatedPhotos.length === 0) {
      return {
        results: [],
        hasMore,
      }
    }

    const { result: modelResult, cost: cost2 } = await modelsService.getDSResponse(
      SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
      JSON.stringify({
        query: this.clearQuery(query.description),
        collection: paginatedPhotos.map((photo, idx) => ({
          id: idx,
          description: photo.chunks.join('... '),
        })),
      }),
      'deepseek-chat',
      null,
      1
    )

    paginatedPhotos = paginatedPhotos.map((photo, idx) => {
      return { ...photo, reasoning: modelResult.find((res: any) => res.id == idx).reasoning }
    })

    const photosResult = paginatedPhotos.filter((_, idx) =>
      modelResult.find((res: any) => res.id == idx && res.isIncluded)
    )

    // Retornar la respuesta
    return {
      results: photosResult,
      hasMore,
      cost: cost2,
    }
  }

  public async search_gpt_img(query: any): Promise<any> {
    const modelsService = new ModelsService()
    const embeddingsService = new EmbeddingsService()

    let photos: Photo[] = await Photo.query().preload('tags')

    const filteredIds = await embeddingsService.getSemanticNearPhotos(photos, query)

    if (query.iteration > 1) {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    if (filteredIds.length === 0) {
      // Si no hay resultados, devolver vacío con mensaje
      return {
        results: [],
      }
    }

    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    const validImages: any[] = []
    for (const id of filteredIds) {
      const photo = photos.find((photo) => photo.id == id)
      if (!photo) continue

      const filePath = path.join(uploadPath, `${photo.name}`)

      try {
        await fs.access(filePath)

        const resizedBuffer = await sharp(filePath)
          .resize({ width: 1024, fit: 'inside' })
          .toBuffer()

        validImages.push({
          id: photo.id,
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (validImages.length === 0) {
      return {
        results: [],
        cost: {
          totalTokens: 0,
          costInEur: '0.000000',
        },
        message: 'No valid images found',
      }
    }

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_SEARCH_MODEL_IMG,
      [
        {
          type: 'text',
          text: JSON.stringify({
            query: query.description,
            flexible: query.iteration > 1,
          }),
        },
        ...validImages.map(({ base64 }) => ({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64}`,
            detail: 'low',
          },
        })),
      ]
    )

    const photosResult = result.map((photoRes: any, idx: number) =>
      photos.find((photo) => photo.id == validImages[photoRes.id].id)
    )

    // Retornar la respuesta
    return {
      results: photosResult[0]?.id ? photosResult : [],
      cost: cost2,
    }
  }

  public clearQuery(description: string): string {
    return description
      .replace('photos of', '')
      .replace('photos with', '')
      .replace('photos at', '')
      .replace('photos in', '')
      .replace('images of', '')
      .replace('images with', '')
      .replace('images at', '')
      .replace('images in', '')
      .replace('pictures of', '')
      .replace('pictures with', '')
      .replace('pictures at', '')
      .replace('pictures in', '')
      .replace('shots of', '')
      .replace('shots with', '')
      .replace('shots at', '')
      .replace('shots in', '')
      .replace('taken at', '')
      .replace('taken in', '')
      .replace('taken on', '')
      .replace('showing', '')
      .replace('depicting', '')
      .replace('featuring', '')
      .trim()
  }
}
