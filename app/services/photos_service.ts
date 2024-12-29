import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'
import fs from 'fs/promises'

import {
  SYSTEM_MESSAGE_QUERY_TO_LOGIC,
  SYSTEM_MESSAGE_SEARCH_GPT,
  SYSTEM_MESSAGE_SEARCH_GPT_IMG,
  SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS,
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

  public async addMetadata(metadata: { id: string; [key: string]: any }[]) {
    const modelsService = new ModelsService()

    for (const data of metadata) {
      const { id, description, ...rest } = data

      const photo = await Photo.query().where('id', id).first()

      if (photo) {
        const fields = Array.from(Photo.$columnsDefinitions.keys()) as (keyof Photo)[]
        const updateData: Partial<Photo> = {}
        const tagInstances = []
        const existingTags = await Tag.all()
        const existingTagNames = existingTags.map((tag) => tag.name)

        // Generate tags from description using new endpoint
        const miscTags = description ? await modelsService.textToTags(description) : []

        for (const key of Object.keys(rest)) {
          if (key.endsWith('_tags')) {
            const group = key.replace('_tags', '')
            const tags = rest[key]
            delete rest[key]

            if (tags && Array.isArray(tags)) {
              for (const tagName of tags) {
                let tag = await Tag.findBy('name', tagName)

                // Check semantic proximity
                if (!tag) {
                  const semanticProximities = await modelsService.semanticProximity(
                    tagName,
                    existingTagNames
                  )
                  const similarTagName = Object.keys(semanticProximities).find(
                    (candidate) => semanticProximities[candidate] >= 80
                  )

                  if (similarTagName) {
                    tag = existingTags.find((t) => t.name === similarTagName) || null
                    console.log(
                      `Tag '${tagName}' replaced with existing tag '${similarTagName}' based on semantic similarity.`
                    )
                  }

                  if (!tag) {
                    tag = await Tag.create({ name: tagName, group })
                  }
                } else {
                  tag.group = group
                  await tag.save()
                }

                tagInstances.push(tag)
              }
            }
          }
        }

        // Process misc tags
        for (const miscTagName of miscTags) {
          let tag = await Tag.findBy('name', miscTagName)

          // Check semantic proximity for misc tags
          if (!tag) {
            const semanticProximities = await modelsService.semanticProximity(
              miscTagName,
              existingTagNames
            )
            const similarTagName = Object.keys(semanticProximities).find(
              (candidate) => semanticProximities[candidate] >= 80
            )

            if (similarTagName) {
              tag = existingTags.find((t) => t.name === similarTagName) || null
              console.log(
                `Misc tag '${miscTagName}' replaced with existing tag '${similarTagName}' based on semantic similarity.`
              )
            }

            if (!tag) {
              tag = await Tag.create({ name: miscTagName, group: 'misc' })
            }
          } else {
            tag.group = 'misc'
            await tag.save()
          }

          tagInstances.push(tag)
        }

        for (const key of fields) {
          if (rest[key]) {
            updateData[key] = rest[key] as any
            delete rest[key]
          }
        }

        // Update photo data
        photo.merge({ ...updateData, description, metadata: { ...photo.metadata, ...rest } })
        await photo.save()

        // Associate tags with the photo
        if (tagInstances.length > 0) {
          await photo.related('tags').sync(
            tagInstances.map((tag) => tag.id),
            false
          )
        }
      }
    }
  }

  private async expandTag(tag: string, tagCollection: string[]): Promise<string[]> {
    const modelsService = new ModelsService()
    const semanticProximities = await modelsService.semanticProximity(tag, tagCollection)
    const uniqueTags = new Set([
      tag,
      ...Object.keys(semanticProximities).filter(
        (candidateTag) => semanticProximities[candidateTag] >= 65
      ),
    ])
    return Array.from(uniqueTags)
  }

  private async expandTags(tags: string[], tagCollection: string[]): Promise<string[][]> {
    const expandedTagsPromises = tags.map(async (tag) => {
      const expansions = await this.expandTag(tag, tagCollection)
      return expansions
    })
    return Promise.all(expandedTagsPromises)
  }

  private filterByTags(
    allPhotos: Photo[],
    expandedMandatoryTags: string[][],
    expandedExcludedTags: string[][],
    expandedOrTags: string[][]
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

    // Filter by excluded tags
    if (expandedExcludedTags.length > 0) {
      filteredPhotos = filteredPhotos.filter((photo) =>
        expandedExcludedTags.every((tagGroup) =>
          tagGroup.every((tag) => !photo.tags.some((t) => t.name === tag))
        )
      )
    }

    // Filter by recommended tags
    if (expandedOrTags.length > 0) {
      filteredPhotos = filteredPhotos.filter((photo) =>
        expandedOrTags.some((tagGroup) =>
          tagGroup.some((tag) => photo.tags.some((t) => t.name === tag))
        )
      )
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
    const tagCollection = tags.map((tag) => tag.name)

    // Step 1: Filter tags based on semantic proximity
    const semanticProximities = await modelsService.semanticProximity(
      query.description,
      tagCollection
    )
    const filteredTags = Object.keys(semanticProximities).filter(
      (tag) => semanticProximities[tag] >= 15
    )

    const { result: formalizedQuery, cost: cost1 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_QUERY_TO_LOGIC,
      JSON.stringify({
        query: query.description,
      })
    )

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_SEARCH_GPT_TO_TAGS,
      JSON.stringify({
        query: formalizedQuery,
        tagCollection: filteredTags,
      })
    )

    const {
      tags_and: tagsAnd,
      reasoning,
      tags_misc: tagsMisc,
      tags_not: tagsNot,
      tags_or: tagsOr,
    } = result

    // Step 2: Expand tags
    const expandedAndTags = await this.expandTags(tagsAnd, tagCollection)
    const expandedNotTags = await this.expandTags(tagsNot, tagCollection)
    const expandedOrTags = await this.expandTags(tagsOr, tagCollection)
    const expandedMiscTags = await this.expandTags(tagsMisc, tagCollection)

    let allPhotos = await Photo.query().preload('tags')

    if (query.iteration > 1) {
      allPhotos = allPhotos.filter((photo) => !query.currentPhotos.includes(photo.id))
    }

    const step1Results = this.filterByTags(
      allPhotos,
      expandedAndTags,
      expandedNotTags,
      expandedOrTags
    )

    let step2Results: Photo[] = []
    if (step1Results.length === 0 && query.iteration > 1) {
      const combinedTags = Array.from(new Set([...tagsAnd, ...expandedMiscTags]))
      step2Results = this.filterByRecommended(allPhotos, combinedTags)
    }

    const filteredPhotos = [...new Set([...step1Results, ...step2Results])]

    return {
      results: filteredPhotos,
      tagsExcluded: expandedNotTags,
      tagsMandatory: expandedAndTags,
      reasoning,
      tagsMisc: expandedMiscTags,
      tagsOr: expandedOrTags,
      cost: cost2,
    }
  }

  // TODO: Cambiar a getGPTResponse de modelService, adaptando el regex de parseo
  public async search_gpt(query: any): Promise<any> {
    let modelsService = new ModelsService()
    let photos: Photo[] = await Photo.query().preload('tags')

    if (query.iteration > 1) {
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
        description: photo?.description + photo?.tags.map((tag: any) => tag.name).join(','),
      }
    })

    if (query.iteration == 1) {
      const { result: formalizedQuery, cost: cost1 } = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_QUERY_TO_LOGIC,
        JSON.stringify({
          query: query.description,
        })
      )
      query.description = formalizedQuery
    }

    const { result, cost: cost2 } = await modelsService.getGPTResponse(
      SYSTEM_MESSAGE_SEARCH_GPT,
      JSON.stringify({
        query: query.description,
        flexible: false,
        collection,
      })
    )

    const photosResult = result.map((res: any) => photos.find((photo: any) => photo.id == res.id))

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
    const resultSetLength = 10
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
