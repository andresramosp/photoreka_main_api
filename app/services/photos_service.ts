import Photo from '#models/photo'
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
      const { id, ...rest } = data

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
    const payload = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: `
            Return only a JSON array containing the IDs of the photos in the following 'collection' whose descriptions semantically resemble the search text in 'query'.
            Matching should not be exact; instead, it should be very broad and general, focusing on concepts and themes rather than specific words. 
            Use the "Accuracy" parameter to determine how much the query should match the description, being: 0 precise, 1 broad, 2 highly broad, almost in a creative way
            If no descriptions match, return an empty JSON array. Do not provide explanations or additional text.
  
            Example 1:
            Input:
            {
              "collection": [
                { "id": 1, "description": "A couple in the park, playing football" },
                { "id": 2, "description": "A couple walking in the city, with a full moon in the sky" }
              ],
              "query": "Images with vegetation",
              "accuracy": 1
            }
            Output:
            [1] // because the park has vegetation, normally!

            Example 2:
            Input:
            {
              "collection": [
                { "id": 1, "description": "A couple in the park, playing football" },
                { "id": 2, "description": "A couple walking in the city, with a full moon in the sky" }
              ],
              "query": "Images during the night",
              "accuracy": 1
            }
            Output:
            [2] // because there is a full moon, so it's night time!

  
            Collection:
            ${JSON.stringify(collection)}
            
            Query: "${query.description}"

            Accuracy: ${query.accuracy}
          `,
        },
      ],
      max_tokens: 5000,
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

      const photosResult = cleanedResults.map((index) => photos[index])

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
          totalTokens: 0,
          costInEur: '0.000000',
        },
      }
    }
  }
}
