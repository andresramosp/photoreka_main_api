import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_TO_LOGIC,
  SYSTEM_MESSAGE_SEARCH_GPT,
  SYSTEM_MESSAGE_SEARCH_GPT_FORMALIZED,
  SYSTEM_MESSAGE_SEARCH_GPT_IMG,
  SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS,
  SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS_V2,
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
    const uniqueTags = new Set([tag, ...Object.keys(semanticProximities)])
    return Array.from(uniqueTags)
  }
  async expandTags(tagArrays, allTags, threshold) {
    const expandedTags = await Promise.all(
      tagArrays.map(async (subArray) => {
        if (subArray.length === 0) return []

        const baseTag = subArray[0] // Only expand based on the first tag
        const newTags = await this.expandTag(baseTag, allTags, threshold)

        return [...subArray, ...Object.values(newTags)] // Append new tags to the original subarray
      })
    )

    return expandedTags // Return the array of arrays
  }

  private filterByTags(
    allPhotos: Photo[],
    expandedMandatoryTags: string[][],
    expandedExcludedTags: string[]
  ) {
    let filteredPhotos = allPhotos

    // Filter by mandatory tags
    if (expandedMandatoryTags.length > 0) {
      filteredPhotos = filteredPhotos.filter((photo) =>
        expandedMandatoryTags.every((tagGroup) =>
          tagGroup.some((tag) => photo.tags.some((t) => t.name === tag))
        )
      )
    }
    const exclusionThreshold = 0 // estricto
    if (expandedExcludedTags.length > 0) {
      filteredPhotos = filteredPhotos.filter((photo) => {
        const excludedTagCount = photo.tags.filter((t) =>
          expandedExcludedTags.includes(t.name)
        ).length
        const exclusionPercentage = (excludedTagCount / expandedExcludedTags.length) * 100
        return exclusionPercentage <= exclusionThreshold
      })
    }

    return filteredPhotos
  }

  private filterByRecommended(allPhotos: Photo[], combinedTags: string[]) {
    return allPhotos.filter((photo) => {
      const matchingTags = photo.tags.filter((t) => combinedTags.includes(t.name))
      const ratio = matchingTags.length / combinedTags.length

      return ratio >= 0.1
    })
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

  public async search_gpt_to_tags(query: any): Promise<any> {
    const modelsService = new ModelsService()

    const tags = await Tag.all()
    const allTags = tags.map((tag) => tag.name)

    // Step 1: Filter tags based on semantic proximity
    const semanticProximities = await modelsService.semanticProximity(
      query.description,
      allTags,
      40 - 3 * query.iteration
    )
    const filteredTags = Object.keys(semanticProximities)

    const { result: formalizedQuery, cost: cost1 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_QUERY_TO_LOGIC,
      JSON.stringify({
        query: query.description,
      })
    )

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS_V2,
      JSON.stringify({
        query: formalizedQuery,
        tagCollection: filteredTags,
      })
    )

    const { tags_and: tagsAnd, reasoning, tags_misc: tagsMisc, tags_not: tagsNot } = result

    // Step 2: Expand tags
    const threshold = 85 - query.iteration * 8
    const expandedAndTags =
      query.iteration > 1 ? await this.expandTags(tagsAnd, allTags, threshold) : tagsAnd
    // const expandedNotTags = await this.expandTags(tagsNot, tagCollection)
    // const expandedMiscTags = await this.expandTags(tagsMisc, tagCollection)

    let allPhotos = await Photo.query()
      .preload('tags')
      .if(query.iteration > 1, (queryBuilder) => {
        queryBuilder.whereNotIn('id', query.currentPhotos)
      })

    const step1Results = this.filterByTags(allPhotos, expandedAndTags, tagsNot)

    let step2Results: Photo[] = []
    // if (step1Results.length === 0 && query.iteration > 1) {
    //   const combinedTags = Array.from(new Set([...tagsAnd, ...expandedMiscTags]))
    //   step2Results = this.filterByRecommended(allPhotos, combinedTags)
    // }

    const filteredPhotos = [...new Set([...step1Results, ...step2Results])]

    console.log(formalizedQuery)
    console.log(result)

    return {
      results: filteredPhotos,
      tagsExcluded: tagsNot,
      tagsMandatory: expandedAndTags,
      reasoning,
      tagsMisc: tagsMisc,
      cost: cost2,
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

    const filteredIds = await this.getSemanticProximePhotos(photos, query)

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
        description: photo?.tags.map((tag: any) => tag.name).join(','),
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

  public async getSemanticProximePhotos(photos: any, query: any) {
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
    const resultSetLength = 20
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
