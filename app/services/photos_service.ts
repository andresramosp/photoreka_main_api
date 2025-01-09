import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
  SYSTEM_MESSAGE_SEARCH_GPT,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_IMG,
  SYSTEM_MESSAGE_SEARCH_MODEL_V2,
  SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4,
  SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
} from '../utils/GPTMessages.js'
import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'
import TagsService from './tags_service.js'

export default class PhotosService {
  /**
   * Asociar tags a una foto
   */
  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  private filterByTags(allPhotos: Photo[], tagsAnd: any[][], tagsNot: string[], tagsOr: string[]) {
    let filteredPhotos = allPhotos

    // los or se meten todos como segmento más del AND
    if (tagsOr.length) tagsAnd.push(tagsOr)

    // Filter by mandatory tags
    if (tagsAnd.length > 0 && tagsAnd[0].length) {
      filteredPhotos = filteredPhotos.filter((photo) => {
        const matchedGroups = tagsAnd.filter((tagGroup) =>
          tagGroup.some((tag) => photo.tags.some((t) => t.name === tag.tag))
        )
        return matchedGroups.length === tagsAnd.length
      })
    }

    const exclusionThreshold = 0 // estricto
    if (tagsNot.length > 0) {
      filteredPhotos = filteredPhotos.filter((photo) => {
        const excludedTagCount = photo.tags.filter((t) => tagsNot.includes(t.name)).length
        const exclusionPercentage = (excludedTagCount / tagsNot.length) * 100
        return exclusionPercentage <= exclusionThreshold
      })
    }

    return filteredPhotos
  }

  private async getSemanticNearTags(
    terms: any,
    tags: any,
    threshold: number = 40,
    maxResults: number = 15
  ) {
    const modelsService = new ModelsService()

    const semanticProximitiesList = await Promise.all(
      terms.map((term: string) => modelsService.semanticProximity(term, tags, threshold))
    )

    // Combinar y filtrar las claves de todos los resultados con sus valores
    const combinedResults = semanticProximitiesList.reduce((acc: any, current) => {
      Object.entries(current).forEach(([key, value]: any) => {
        if (!acc[key] || acc[key] < value) {
          acc[key] = value // Mantén el mayor valor de proximidad
        }
      })
      return acc
    }, {})

    // Convertir el objeto combinado a un array de objetos { name, value }
    const sortedResults = Object.entries(combinedResults)
      .map(([name, value]) => ({ name, value }))
      .sort((a: any, b: any) => b.value - a.value) // Ordenar por proximidad descendente
      .slice(0, maxResults) // Tomar solo los N más cercanos

    return sortedResults
  }

  public async saveExpandadTags(term: any, tags: any[], expansionResults: any) {
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
    const tagsService = new TagsService()

    await Promise.all(
      terms.map(async (term) => {
        // const nearTags = await this.getSemanticNearTags(
        //   [term.tagName],
        //   allTags.map((tag) => tag.name).filter((tagName) => tagName !== term.tagName),
        //   30,
        //   20
        // )
        const nearTags = await tagsService.findSimilarTags(tag)
        const existingTag = allTags.find((tag) => tag.name === term.tagName)
        if (existingTag && existingTag.children?.tags.length) {
          expansionResults[term.tagName] = existingTag.children.tags || []
          console.log(
            `Using stored expansors for ${term.tagName}: ${JSON.stringify(existingTag.children.tags.map((t: any) => t.tag))} `
          )
        } else {
          const { result, cost } = await modelsService.getDSResponse(
            term.isAction
              ? SYSTEM_MESSAGE_TERMS_ACTIONS_EXPANDER_V4
              : SYSTEM_MESSAGE_TERMS_EXPANDER_V4,
            JSON.stringify({
              // operation: 'semanticSubExpansion',
              term: term.tagName,
              tagCollection: nearTags.map((tag) => tag.name),
            })
            // 'ft:gpt-4o-mini-2024-07-18:personal:refine:AlpaXAxW'
          )

          // Recuperamos la proximidad semántica
          if (result.length) {
            for (let tag of result) {
              tag.value = nearTags.find((nearTag) => nearTag.name == tag.tag)?.value
            }
            expansionResults[term.tagName] = result.filter((tag: any) => tag.isSubclass)
          } else {
            expansionResults[term.tagName] = []
          }

          expansionCosts.push(cost)
          this.saveExpandadTags(term, allTags, expansionResults)
        }
      })
    )

    return { expansionResults, expansionCosts }
  }

  public async search_gpt_to_tags_v2(query: any): Promise<any> {
    const modelsService = new ModelsService()

    const allTags = await Tag.all()
    let allPhotos
    let cost1
    let queryLogicResult

    if (query.iteration == 1) {
      const { result, cost } = await modelsService.getDSResponse(
        SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
        JSON.stringify({
          query: query.description,
        })
        //'ft:gpt-4o-mini-2024-07-18:personal:refine:AlpaXAxW'
      )
      if (result == 'NON_TAGGABLE') {
        console.log('Query non taggable: ', query.description)
        return this.search_desc(query)
      }
      queryLogicResult = result
      cost1 = cost
      allPhotos = await Photo.query().preload('tags')
    } else {
      queryLogicResult = query.currentQueryLogicResult
      allPhotos = await Photo.query()
        .preload('tags')
        .if(query.iteration > 1, (queryBuilder) => {
          queryBuilder.whereNotIn('id', query.currentPhotos)
        })
    }

    const terms = [
      ...queryLogicResult.tags_and,
      ...queryLogicResult.tags_not,
      ...queryLogicResult.tags_or,
    ]

    let { expansionResults, expansionCosts } = await this.performTagsExpansion(terms, allTags)

    let tagsAnd, tagsNot, tagsOr
    let tagPerIteration = 3
    let results = []
    let hasMoreTerms = true

    do {
      tagsAnd = queryLogicResult.tags_and.map((tag: any) => {
        const expandedTerms = expansionResults[tag.tagName].slice(
          0,
          query.iteration * tagPerIteration
        )
        const hasMore = expandedTerms.length < expansionResults[tag.tagName].length
        tag.hasMore = hasMore
        return expandedTerms.length
          ? [{ tag: tag.tagName, value: 100 }, ...expandedTerms]
          : [{ tag: tag.tagName, value: 100 }]
      })

      tagsNot = queryLogicResult.tags_not
        .map((tag: any) => {
          const expandedTerms = expansionResults[tag.tagName].slice(0, tagPerIteration) // En not no expandimos más con iterations
          const hasMore = expandedTerms.length < expansionResults[tag.tagName].length
          tag.hasMore = hasMore
          return expandedTerms.length ? [tag.tagName, ...expandedTerms] : [tag.tagName]
        })
        .flat()

      tagsOr = queryLogicResult.tags_or
        .map((tag: any) => {
          const expandedTerms = expansionResults[tag.tagName].slice(
            0,
            query.iteration * tagPerIteration
          )
          const hasMore = expandedTerms.length < expansionResults[tag.tagName].length
          tag.hasMore = hasMore
          return expandedTerms.length ? [tag.tagName, ...expandedTerms] : [tag.tagName]
        })
        .flat()

      results = this.filterByTags(allPhotos, tagsAnd, tagsNot, tagsOr)

      const andHasMore = queryLogicResult.tags_and.some((tag: any) => tag.hasMore)
      const orHasMore = queryLogicResult.tags_or.some((tag: any) => tag.hasMore)

      hasMoreTerms = andHasMore || orHasMore

      query.iteration++
    } while (!results.length && hasMoreTerms)

    return {
      results: [...new Set([...results])],
      cost: { cost1, expansionCosts },
      queryLogicResult,
      termsExpansion: { tagsAnd, tagsNot, tagsOr },
      hasMore: hasMoreTerms,
      searchType: 'TAGS',
    }
  }

  // TODO: Cambiar a getGPTResponse de modelService, adaptando el regex de parseo
  public async search_desc(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration == 1) {
    } else {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    const nearPhotos = await this.getSemanticNearPhotos(photos, query, 30)
    let pageSize = 10
    const offset = (query.iteration - 1) * pageSize
    const paginatedPhotos = nearPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < nearPhotos.length

    if (paginatedPhotos.length === 0) {
      return {
        results: [],
        hasMore,
      }
    }

    const { result, cost: cost2 } = await modelsService.getDSResponse(
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

    const photosResult = paginatedPhotos.filter((_, idx) =>
      result.find((res: any) => res.id == idx && res.isIncluded)
    )

    // Retornar la respuesta
    return {
      results: photosResult,
      reasoning: result.map((res: any) => {
        return {
          ...res,
          chunks: paginatedPhotos.find((_, idx) => res.id == idx).chunks.join('... '),
        }
      }),
      hasMore,
      cost: cost2,
      searchType: 'GPT',
    }
  }

  public async search_creative(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration == 1) {
    } else {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    const nearPhotos = await this.getSemanticNearPhotos(photos, query, 30, 20)
    let pageSize = 5
    const offset = (query.iteration - 1) * pageSize
    const paginatedPhotos = nearPhotos.slice(offset, offset + pageSize)
    const hasMore = offset + pageSize < nearPhotos.length

    if (paginatedPhotos.length === 0) {
      return {
        results: [],
        hasMore,
      }
    }

    const { result, cost: cost2 } = await modelsService.getDSResponse(
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

    const photosResult = paginatedPhotos.filter((_, idx) =>
      result.find((res: any) => res.id == idx && res.isIncluded)
    )

    // Retornar la respuesta
    return {
      results: photosResult,
      reasoning: result.map((res: any) => {
        return {
          ...res,
          chunks: paginatedPhotos.find((_, idx) => res.id == idx).chunks.join('... '),
        }
      }),
      hasMore,
      cost: cost2,
      searchType: 'GPT',
    }
  }

  public async getSemanticNearPhotos(
    photos: any,
    query: any,
    resultSetLength = 10,
    similarityThresholdDesc = 25
  ) {
    const modelsService = new ModelsService()

    // Obtener las proximidades semánticas iniciales (tags)
    const semanticProximities = await modelsService.semanticProximity(
      query.description,
      photos.map((photo: any) => ({
        id: photo.id,
        text: photo.tags.map((tag: any) => tag.name).join(','),
      }))
    )

    const sortedProximities = Object.entries(semanticProximities).sort(([, a], [, b]) => b - a)
    const topCount = Math.ceil(resultSetLength)

    const topIds = sortedProximities.slice(0, topCount).map(([id]) => id)

    const filteredIds = Array.from(new Set([...topIds]))

    // Filtrar las fotos seleccionadas
    const filteredPhotos = photos.filter((photo: any) => filteredIds.includes(photo.id))

    // Analizar las descriptions de las fotos seleccionadas
    const promises = filteredPhotos.map(async (photo: Photo) => {
      if (!photo.description) return null

      // Obtener proximidades de los chunks
      const chunkProximities = await modelsService.semanticProximitChunks(
        query.description,
        photo.description,
        query.description.length * 8
      )

      // Filtrar chunks por umbral de proximidad y ordenarlos
      const selectedChunks = chunkProximities
        .filter(({ proximity }: any) => proximity >= similarityThresholdDesc / 100)
        .sort((a: any, b: any) => b.proximity - a.proximity)

      return {
        ...photo.$attributes,
        chunks: selectedChunks.map(({ text_chunk }: any) => text_chunk),
      }
    })

    // Esperar a que todas las promesas se resuelvan
    const results = (await Promise.all(promises)).filter(Boolean)

    // Devolver los resultados
    return results.filter((photo) => photo.chunks.length)
  }

  public async search_gpt_img(query: any): Promise<any> {
    const modelsService = new ModelsService()

    let photos: Photo[] = await Photo.query().preload('tags')

    const filteredIds = await this.getSemanticNearPhotos(photos, query)

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
