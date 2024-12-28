import Photo from '#models/photo'
import Tag from '#models/tag'
import env from '#start/env'
import axios from 'axios'

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
        const miscTags = description ? await this.fetchTagsByDescription(description) : []

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
                  const semanticProximities = await this.fetchSemanticProximity(
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
            const semanticProximities = await this.fetchSemanticProximity(
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

  private async fetchTagsByDescription(description: string): Promise<string[]> {
    try {
      const payload = { description }
      const { data } = await axios.post('http://127.0.0.1:5000/generate_tags', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data.generated_tags || []
    } catch (error) {
      console.error('Error fetching tags by description:', error)
      return []
    }
  }
  private async fetchSemanticProximity(
    query: string,
    tagCollection: string[]
  ): Promise<{ [key: string]: number }> {
    try {
      const payload = {
        tag: query,
        tag_list: tagCollection,
      }

      const { data } = await axios.post('http://127.0.0.1:5000/semantic_proximity', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data.similarities || {}
    } catch (error) {
      console.error('Error fetching semantic proximity:', error)
      return {}
    }
  }

  private async expandTag(tag: string, tagCollection: string[]): Promise<string[]> {
    const semanticProximities = await this.fetchSemanticProximity(tag, tagCollection)
    const uniqueTags = new Set([
      tag,
      ...Object.keys(semanticProximities).filter(
        (candidateTag) => semanticProximities[candidateTag] >= 55
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

  public async search_v1_gpt_tags(query: any): Promise<any> {
    const tags = await Tag.all()
    const tagCollection = tags.map((tag) => tag.name)

    // Step 1: Filter tags based on semantic proximity
    const semanticProximities = await this.fetchSemanticProximity(query.description, tagCollection)
    const filteredTags = Object.keys(semanticProximities).filter(
      (tag) => semanticProximities[tag] >= 15
    )

    const {
      tags_and: tagsMandatory,
      tags_misc: tagsRecommended,
      tags_not: tagsExcluded,
      converted_query,
      usage,
    } = await this.getGPTResponse(query.description, filteredTags)

    // Step 2: Expand tags
    const expandedMandatoryTags = await this.expandTags(tagsMandatory, tagCollection)
    const expandedExcludedTags = await this.expandTags(tagsExcluded, tagCollection)

    const allPhotos = await Photo.query().preload('tags')

    // Step 3: Filter photos based on expanded tags (Step 1)
    const step1Results = this.filterByTags(allPhotos, expandedMandatoryTags, expandedExcludedTags)

    let step2Results: Photo[] = []
    // if (step1Results.length === 0) {
    //   const combinedTags = Array.from(new Set([...tagsMandatory, ...tagsRecommended]))
    //   step2Results = this.filterByRecommended(allPhotos, combinedTags, tagsExcluded)
    // }

    let step3Results: Photo[] = []
    // if (step1Results.length === 0 && step2Results.length === 0) {
    //   const combinedTags = Array.from(new Set([...tagsMandatory, ...tagsRecommended]))
    //   step3Results = this.filterByDescription(allPhotos, combinedTags)
    // }

    // Combine results
    const filteredPhotos = [...new Set([...step1Results, ...step2Results, ...step3Results])]

    const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage
    const totalTokens = promptTokens + completionTokens
    const costInEur = totalTokens * COST_PER_TOKEN_EUR

    return {
      results: filteredPhotos,
      tagsExcluded: expandedExcludedTags,
      tagsMandatory: expandedMandatoryTags,
      converted_query,
      tagsRecommended,
      cost: {
        costInEur: costInEur.toFixed(6),
        totalTokens,
      },
    }
  }

  private async getGPTResponse(query: string, tagCollection: string[]) {
    const payload = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `
                You are a JSON returner, and only JSON, in charge of identifying relevant tags for a photo search. This tags can be found in 'tagCollection' and you must return only tags which are present there.
                The user has given you in the text 'query' their search criteria in natural language, and you must return three arrays, which later will be use to compose a BD query.
                
                But first you have to carefully convert the query to separated logical segments, attending to all the query requierements, which are not always obvious like AND AND AND... 
                Example1: For the query "photos with vegetation in cities with no people around", you can convert it to: "Photos that have vegetation AND are in cities with NOT people around".
                Example2: For the query "photos inside restaurants with pets", you can convert it to: "Photos in a restaurant AND inside AND with pets".
                
                Then return these lists:

                - tags_and (max. 1 tags per logical segment): each of these tags corresponds to a logical AND segment of the query. 
                - tags_not (max. 1 tag per logical segment): each of these tags corresponds to a logical NOT segment of the query. 
                - tags_misc (max 5 tags): other relevant tags related to the query, useful to refine the search
                - converted_query: the query converted to logical segments, to debug it
                
                Example: For the query "photos of children on an Asian beach with no pets around. 
                First, convert the query to understand the logical segments: "photos with children AND placed in Asia AND in the beach with NOT pet around"
                Second, create the three arrays according to the exact segments:
                { 
                    "tags_and": ["children", "asia", "beach"], 
                    "tags_not": ["pets"],
                    "tags_misc": ["summer", "vacation", "waves", "joyful"], 
                    "converted_query": "photos with children AND placed in Asia AND in the beach with NOT pet around"
                    
                }.
                `,
        },
        {
          role: 'user',
          content: JSON.stringify({ query, tagCollection }),
        },
      ],
      max_tokens: 10000,
    }

    const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
      headers: {
        'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
        'Content-Type': 'application/json',
      },
    })

    const rawResult = data.choices[0].message.content
    const jsonMatch = rawResult.match(/\{.*?\}/s)
    return jsonMatch
      ? { ...JSON.parse(jsonMatch[0]), usage: data.usage }
      : { tags_and: [], tags_some: [], tags_not: [], usage: data.usage }
  }

  private filterByTags(
    allPhotos: Photo[],
    expandedMandatoryTags: string[][],
    expandedExcludedTags: string[][]
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

    return filteredPhotos
  }

  private filterByRecommended(allPhotos: Photo[], combinedTags: string[], tagsExcluded: string[]) {
    return allPhotos.filter((photo) => {
      const matchingTags = photo.tags.filter((t) => combinedTags.includes(t.name))
      const ratio = matchingTags.length / combinedTags.length

      const hasExcludedTags = tagsExcluded.some((tag: string) =>
        photo.tags.some((t) => t.name === tag)
      )

      return ratio >= 0.5 && !hasExcludedTags
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
