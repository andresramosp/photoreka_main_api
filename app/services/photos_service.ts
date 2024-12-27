import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

// import * as use from '@tensorflow-models/universal-sentence-encoder';

// let model; // Cargar el modelo una sola vez para evitar sobrecarga
// (async () => {
//   model = await use.load(); // Cargar el modelo en memoria
// })();

export default class PhotosService {
  /**
   * Asociar tags a una foto
   */
  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async addMetadata(metadata: { id: string; [key: string]: any }[]) {
    for (const data of metadata) {
      const { id, tags, ...rest } = data

      const photo = await Photo.query().where('id', id).first()

      if (photo) {
        // Separate fields that match columns in Photo
        const fields = Array.from(Photo.$columnsDefinitions.keys()) as (keyof Photo)[]

        const updateData: Partial<Photo> = {}

        for (const key of fields) {
          if (rest[key]) {
            updateData[key] = rest[key] as any
            delete rest[key]
          }
        }

        // Update photo data
        photo.merge({ ...updateData, metadata: { ...photo.metadata, ...rest } })
        await photo.save()

        // Process tags
        if (tags && Array.isArray(tags)) {
          const tagInstances = []
          for (const tagName of tags) {
            let tag = await Tag.findBy('name', tagName)
            if (!tag) {
              tag = await Tag.create({ name: tagName })
            }
            tagInstances.push(tag)
          }

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
  }
  public async search_v1_gpt_tags(query: any): Promise<any> {
    const tags = await Tag.all()

    // Prepare a collection of tags for GPT prompt
    const tagCollection = tags.map((tag) => tag.name)

    // Prepare the GPT prompt
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `
          You are a JSON returner, and only JSON, in charge of identifying relevant tags for a photo search. This tags can be found in 'tagCollection' and you must return only tags which are present there.
          The user has given you in the text 'query' their search criteria in natural language, and you must return three arrays:
          - tags_mandatory (max. 3 tags): tags that MUST CLEARLY be present in photos, according to the logic of the query.
          - tags_excluded (max 3 tags): tags that MUST NOT CLEARLY be present in photos.
          - tags_recommended (max 5 tags): tags that are useful but not mandatory.
          Example: For the query "photos of children on an Asian beach with NO pets around", return:
          { 
            "tags_mandatory": ["children", "beach", "Asia"], 
            "tags_recommended": ["summer", "vacation", "waves"], 
            "tags_excluded": ["pets", "dogs", "cats", "Europe", "Africa", "London"] 
          }.
        `,
        },
        {
          role: 'user',
          content: JSON.stringify({ query: query.description, tagCollection }),
        },
      ],
      max_tokens: 10000,
    }

    let rawResult
    let jsonMatch
    let cleanedResults: any

    try {
      // Send request to OpenAI
      const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
        headers: {
          'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
          'Content-Type': 'application/json',
        },
      })

      // Process OpenAI response
      rawResult = data.choices[0].message.content
      jsonMatch = rawResult.match(/\{.*?\}/s)
      cleanedResults = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { tags_mandatory: [], tags_recommended: [], tags_excluded: [] }

      const {
        tags_mandatory: tagsMandatory,
        tags_recommended: tagsRecommended,
        tags_excluded: tagsExcluded,
      } = cleanedResults

      // Load all photos with their tags
      const allPhotos = await Photo.query().preload('tags')

      // Filter photos in JavaScript
      let filteredPhotos = allPhotos

      // Step 1: Filter by mandatory and excluded tags
      if (tagsMandatory.length > 0) {
        filteredPhotos = filteredPhotos.filter((photo) =>
          tagsMandatory.every((tag: string) => photo.tags.some((t) => t.name === tag))
        )
      }

      if (tagsExcluded.length > 0) {
        filteredPhotos = filteredPhotos.filter((photo) =>
          tagsExcluded.every((tag: string) => !photo.tags.some((t) => t.name === tag))
        )
      }

      // Step 2: If no results, filter by combined mandatory and recommended tags, considering excluded tags
      if (filteredPhotos.length === 0) {
        const combinedTags = Array.from(new Set([...tagsMandatory, ...tagsRecommended]))

        filteredPhotos = allPhotos.filter((photo) => {
          const matchingTags = photo.tags.filter((t) => combinedTags.includes(t.name))
          const ratio = matchingTags.length / combinedTags.length

          const hasExcludedTags = tagsExcluded.some((tag: string) =>
            photo.tags.some((t) => t.name === tag)
          )

          return ratio >= 0.1 && !hasExcludedTags // Ensure at least 50% of the combined tags are matched and no excluded tags
        })
      }

      // Step 3: If no results, filter by searching in the description, at least 20% of the tags, not case sensisitve
      if (filteredPhotos.length === 0) {
        const lowerCaseTags = tagsMandatory.concat(tagsRecommended).map((tag) => tag.toLowerCase())

        filteredPhotos = allPhotos.filter((photo) => {
          if (!photo.description) return false
          const descriptionLower = photo.description.toLowerCase()

          const matchingTagsCount = lowerCaseTags.reduce((count, tag) => {
            return descriptionLower.includes(tag) ? count + 1 : count
          }, 0)

          const matchRatio = matchingTagsCount / lowerCaseTags.length
          return matchRatio >= 0.5 // Ensure at least 20% of the tags match in the description
        })
      }
      // Calculate cost
      const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = data.usage
      const totalTokens = promptTokens + completionTokens
      const costInEur = totalTokens * COST_PER_TOKEN_EUR

      // Return response
      return {
        results: filteredPhotos,
        tagsExcluded,
        tagsMandatory,
        tagsRecommended,
        cost: {
          totalTokens,
          costInEur: costInEur.toFixed(6),
        },
      }
    } catch (error) {
      // Handle errors gracefully
      return {
        results: [],
        cost: {
          totalTokens: 0,
          costInEur: '0.000000',
        },
      }
    }
  }

  public async search_v1_gpt(query: any): Promise<any> {
    const photos: Photo[] = await Photo.all()

    // Crear el collection para el payload
    const collection = photos.map((photo, index) => ({
      id: index,
      description: photo.description,
    }))

    // Crear el payload para OpenAI
    // Crear el payload para OpenAI
    const payload = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `
        You are a JSON returner, and only JSON, in charge of performing complex photo searches.
        The user has given you in the text 'query' what they want, in natural language, and you must search the photos provided in 'collection', through their descriptions, those that are relevant to the user's query. 
        Use the 'accuracy' field to determine how literally you must understand the query and therefore the filtering, being:
        - 0: Totally literal
        - 1: More general
        - 2: Very flexible
        Return a JSON with an array containing objects like this:
        {id: '1234', reason: 'because there are two dogs'}, where:
          - id: The ID of the photo.
          - reason: A short justification of why you chose it.
        If no descriptions match, return a JSON array with an item like this {id:null, reason: 'explanation of why no photos matched'}: .
      `,
        },
        {
          role: 'user',
          content: JSON.stringify({
            query: query.description,
            accuracy: query.accuracy,
            collection,
          }),
        },
      ],
      max_tokens: 10000,
    }

    let rawResult
    let jsonMatch
    let cleanedResults: any[]

    try {
      // Enviar solicitud a OpenAI
      const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
        headers: {
          'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
          'Content-Type': 'application/json',
        },
      })

      // Procesar la respuesta de OpenAI
      rawResult = data.choices[0].message.content

      // Extraer JSON de la respuesta incluso si hay texto adicional
      jsonMatch = rawResult.match(/\[.*?\]/s)
      cleanedResults = jsonMatch ? JSON.parse(jsonMatch[0]) : []

      const photosResult = cleanedResults.map((res) => photos[res.id])

      console.log(cleanedResults)

      // Calcular el costo

      const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = data.usage
      const totalTokens = promptTokens + completionTokens
      const costInEur = totalTokens * COST_PER_TOKEN_EUR

      // Retornar la respuesta
      return {
        results: photosResult,
        cost: {
          totalTokens,
          costInEur: costInEur.toFixed(6),
        },
      }
    } catch (error) {
      // Manejar errores de parseo o solicitud
      return {
        results: [],
        cost: {
          totalTokensy: 0,
          costInEur: '0.000000',
        },
      }
    }
  }
}
