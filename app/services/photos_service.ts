import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_TO_LOGIC,
  SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
  SYSTEM_MESSAGE_SEARCH_GPT,
  SYSTEM_MESSAGE_SEARCH_GPT_FORMALIZED,
  SYSTEM_MESSAGE_SEARCH_GPT_IMG,
  SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS,
  SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS_V2,
  SYSTEM_MESSAGE_TERMS_EXPANDER,
  SYSTEM_MESSAGE_TERMS_EXPANDER_V2,
} from '../utils/GPTMessages.js'
import ModelsService from './models_service.js'
import path from 'path'
import sharp from 'sharp'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

export default class PhotosService {
  /**
   * Asociar tags a una foto
   */
  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  private async expandTag(
    tag: string,
    tagCollection: string[],
    threshold: number
  ): Promise<string[]> {
    const modelsService = new ModelsService()
    const semanticProximities = await modelsService.semanticProximity(tag, tagCollection, threshold)
    return Array.from(Object.keys(semanticProximities))
  }
  async expandTags(tagArrays: any, allTags: any, threshold: number) {
    const expandedTags = await Promise.all(
      tagArrays.map(async (subArray: any) => {
        if (subArray.length === 0) return []

        const baseTag = subArray[0] // Only expand based on the first tag
        const newTags = await this.expandTag(baseTag, allTags, threshold)

        let result = new Set([...subArray, ...Object.values(newTags)]) // Append new tags to the original subarray
        return Array.from(result)
      })
    )

    return expandedTags // Return the array of arrays
  }

  private filterByTags(
    allPhotos: Photo[],
    tagsAnd: string[][],
    tagsNot: string[],
    tagsOr: string[],
    flexible: boolean
  ) {
    let filteredPhotos = allPhotos

    // los or se meten todos como segmento más del AND
    if (tagsOr.length) tagsAnd.push(tagsOr)

    // Filter by mandatory tags
    if (tagsAnd.length > 0 && tagsAnd[0].length) {
      filteredPhotos = filteredPhotos.filter((photo) => {
        const matchedGroups = tagsAnd.filter((tagGroup) =>
          tagGroup.some((tag) => photo.tags.some((t) => t.name === tag))
        )
        return flexible
          ? matchedGroups.length >= Math.ceil((tagsAnd.length * 2) / 3)
          : matchedGroups.length === tagsAnd.length
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

  private filterByDescription(allPhotos: Photo[], tags: string[]) {
    const lowerCaseTags = tags.map((tag) => tag.toLowerCase())

    return allPhotos.filter((photo) => {
      if (!photo.description) return false
      const descriptionLower = photo.description.toLowerCase()

      const matchingTagsCount = lowerCaseTags.reduce((count, tag) => {
        return descriptionLower.includes(tag) ? count + 1 : count
      }, 0)

      const matchRatio = matchingTagsCount / lowerCaseTags.length
      return matchRatio >= 0.2
    })
  }

  private async getSemanticNearTags(terms: any, tags: any, query: any) {
    const modelsService = new ModelsService()

    const semanticProximitiesList = await Promise.all(
      terms.map((term: string) =>
        modelsService.semanticProximity(term, tags, 50 - 7 * query.iteration)
      )
    )

    // Combinar y filtrar las claves de todos los resultados
    return semanticProximitiesList.reduce((acc: any, current) => {
      const keys = Object.keys(current)
      keys.forEach((key) => {
        if (!acc.includes(key)) {
          acc.push(key) // Agrega solo las claves únicas
        }
      })
      return acc
    }, [])
  }

  public async search_gpt_to_tags_v2(query: any): Promise<any> {
    const modelsService = new ModelsService()

    const tags = await Tag.all()
    let allTags = tags.map((tag) => tag.name)
    let allPhotos
    let cost1
    let queryLogicResult

    if (query.iteration == 1) {
      const { result, cost } = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_QUERY_TO_LOGIC_V2,
        JSON.stringify({
          query: query.description,
        })
      )
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

    // Quito de los tags los que ya estan en el dictionary. Quiza habria que afinar y quitar por term.
    if (query.currentExpandedDict) {
      let currentQueryTags = [...new Set(Object.values(query.currentExpandedDict).flat())]
      allTags = allTags.filter((tag) => !currentQueryTags.includes(tag))
    }

    const filteredTags = await this.getSemanticNearTags(terms, allTags, query)

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_TERMS_EXPANDER_V2,
      JSON.stringify({
        terms,
        tagCollection: filteredTags,
      }),
      'ft:gpt-4o-mini-2024-07-18:personal:curatorlab:AlGXR5Ns'
    )

    const expandedDictionary = Object.entries(result).reduce((acc: any, [key, value]: any) => {
      acc[key] = value
        .filter(
          (item: any) => item.isSubtype || item.tagName.includes(key) || key.includes(item.tagName)
        )
        .map((item: any) => item.tagName)
      return acc
    }, {})

    const mergedDictionary = { ...expandedDictionary }

    for (const key in query.currentExpandedDict) {
      if (Array.isArray(query.currentExpandedDict[key])) {
        mergedDictionary[key] = [
          ...new Set([...(mergedDictionary[key] || []), ...query.currentExpandedDict[key]]),
        ]
      } else {
        mergedDictionary[key] = query.currentExpandedDict[key]
      }
    }

    let tagsAnd, tagsNot, tagsOr

    tagsAnd = queryLogicResult.tags_and.map((tag: string) => {
      let expandedTerms = mergedDictionary[tag].length ? [tag, ...mergedDictionary[tag]] : [tag]
      return expandedTerms
    })
    tagsNot = queryLogicResult.tags_not
      .map((tag: string) => {
        let expandedTerms = mergedDictionary[tag].length ? [tag, ...mergedDictionary[tag]] : [tag]
        return expandedTerms
      })
      .flat()
    tagsOr = queryLogicResult.tags_or
      .map((tag: string) => {
        let expandedTerms = mergedDictionary[tag].length ? [tag, ...mergedDictionary[tag]] : [tag]
        return expandedTerms
      })
      .flat()

    const results = this.filterByTags(allPhotos, tagsAnd, tagsNot, tagsOr, query.iteration > 2)
    const filteredPhotos = [...new Set([...results])]

    return {
      results: filteredPhotos,
      cost: { cost1, cost2 },
      queryLogicResult,
      expandedDictionary: mergedDictionary,
    }
  }

  // TODO: Cambiar a getGPTResponse de modelService, adaptando el regex de parseo
  public async search_gpt(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration == 1) {
      const { result: formalizedQuery, cost: cost1 } = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_QUERY_TO_LOGIC,
        JSON.stringify({
          query: query.description,
        })
      )
      query.description = formalizedQuery.result
    } else {
      photos = photos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    const filteredIds = await this.getSemanticProximePhotos(photos, query, 20)

    if (filteredIds.length === 0) {
      return {
        results: [],
      }
    }

    let collection: any = filteredIds.map((id: any) => {
      let photo: any = photos.find((photo) => photo.id == id)
      return {
        id,
        // description: photo?.description,
        description: photo?.description + ' ' + photo?.tags.map((tag: any) => tag.name).join(','), // TODO solo tags semanticamente proximas! Y apra desc?
      }
    })

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_SEARCH_GPT_FORMALIZED,
      JSON.stringify({
        query: query.description,
        collection,
      }),
      'gpt-4o-mini'
    )

    const photosResult = result.map((res: any) => photos.find((photo: any) => photo.id == res.id))

    console.log(query.description)
    console.log(result)

    // Retornar la respuesta
    return {
      results: photosResult[0]?.id ? photosResult : [],
      cost: cost2,
    }
  }

  public async getSemanticProximePhotos(photos: any, query: any, resultSetLength = 10) {
    // Obtener las proximidades semánticas
    const modelsService = new ModelsService()
    const semanticProximities = await modelsService.semanticProximity(
      query.description,
      photos.map((photo: any) => {
        return {
          id: photo.id,
          text: photo.tags.map((tag: any) => tag.name).join(','),
        }
      })
    )

    // Obtener el X% superior de similitudes
    const similarityThreshold = 50 // Umbral mínimo de similitud

    const sortedProximities = Object.entries(semanticProximities).sort(([, a], [, b]) => b - a)
    const topCount = Math.ceil(resultSetLength)

    const topIds = sortedProximities.slice(0, topCount).map(([id]) => id)
    const thresholdIds = Object.entries(semanticProximities)
      .filter(([, similarity]) => similarity >= similarityThreshold)
      .map(([id]) => id)

    const filteredIds = Array.from(new Set([...topIds, ...thresholdIds]))
    return filteredIds
  }

  public async search_gpt_img(query: any): Promise<any> {
    const modelsService = new ModelsService()

    let photos: Photo[] = await Photo.query().preload('tags')

    const filteredIds = await this.getSemanticProximePhotos(photos, query)

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
      SYSTEM_MESSAGE_SEARCH_GPT_IMG,
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

    const photosResult = result.map((photoRes, idx) =>
      photos.find((photo) => photo.id == validImages[photoRes.id].id)
    )

    // Retornar la respuesta
    return {
      results: photosResult[0]?.id ? photosResult : [],
      cost: cost2,
    }
  }
}
