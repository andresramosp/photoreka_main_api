import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import env from '#start/env'
import axios from 'axios'
import PhotosService from './photos_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

export default class AnalyzerService {
  /**
   * Asociar tags a una foto con soporte por lotes
   */
  public async analyze(photosIds: string[], maxImagesPerBatch = 10) {
    const photosService = new PhotosService()

    const photos = await photosService.getPhotosByIds(photosIds)

    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    const validImages = []
    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`) // Ajusta la extensión según corresponda

      try {
        // Verificar si el archivo existe
        await fs.access(filePath)

        // Procesar la imagen con sharp
        const resizedBuffer = await sharp(filePath).resize({ width: 512, fit: 'inside' }).toBuffer()

        validImages.push({
          id: photo.id, // Usar el ID proporcionado
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (validImages.length === 0) {
      throw new Exception('No valid images found for the provided IDs')
    }

    const results = []
    let totalTokensUsed = 0

    // Procesar en lotes
    for (let i = 0; i < validImages.length; i += maxImagesPerBatch) {
      const batch = validImages.slice(i, i + maxImagesPerBatch)

      const payload = {
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `
                  Return a JSON array, where each element contains information about one image. For each image, include:
                  - 'id': id of the image, using this comma-separated, ordered list: ${batch.map((img) => img.id).join(',')}
                  - 'description' (around 500 words): describe the image in detail, aseptically, including type of place, the time of day, the country or culture, the objects and the people and their actions. This description should work for a further search, like "people looking at their phones at subway", therefore include as many relevant words as you can
                  - 'tags': an array of relevant tags, considering objects, people, environment, culture/country, atmosphere, and photography style
                `,
              },
              ...batch.map(({ base64 }) => ({
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64}`,
                  detail: 'low',
                },
              })),
            ],
          },
        ],
        max_tokens: 10000,
      }

      try {
        const { data } = await axios.post(
          env.get('OPENAI_BASEURL') + '/chat/completions',
          payload,
          {
            headers: {
              'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
              'Content-Type': 'application/json',
            },
          }
        )

        // Procesar la respuesta
        const rawResult = data.choices[0].message.content
        const cleanedResults = JSON.parse(rawResult.replace(/```json|```/g, '').trim())

        results.push(...cleanedResults)
        totalTokensUsed += data.usage.total_tokens
      } catch (error) {
        console.error(`Error procesando el lote:`, error)
      }
    }

    if (results.length === 0) {
      throw new Exception('No results returned from the OpenAI API')
    }

    // Agregar metadatos
    await photosService.addMetadata(results)

    // Calcular el costo
    const costInEur = totalTokensUsed * COST_PER_TOKEN_EUR

    // Retornar el resultado combinado
    return {
      results,
      cost: {
        tokensUsed: totalTokensUsed,
        costInEur: costInEur.toFixed(6),
      },
    }
  }
}
