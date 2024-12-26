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
   * Asociar tags a una foto
   */
  public async analyze(photosIds: string[]) {
    const photosService = new PhotosService()

    const photos: Photo[] = await photosService.getPhotosByIds(photosIds)

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

    //  - 'description' (max 70 words): describe the general scene, the environment, what is doing each person and their interactions, and pay special attention to curious or strange details, funny contrasts or optical illusions, that can make this a good street photography.

    // Crear el payload para OpenAI
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
              - 'id': id of the image, using this comma separated, ordered list: ${validImages.map((img) => img.id).join(',')}
              - 'description: describe the image in detail, aseptically, including type of place, the time of day, the objects and the people and their actions. This description should work for a further search, like "people looking at their phones at subway", therefore include has many relevant words as you can
            `,
            },
            ...validImages.map(({ base64 }) => ({
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

    // Enviar solicitud a OpenAI
    const { data } = await axios.post(env.get('OPENAI_BASEURL') + '/chat/completions', payload, {
      headers: {
        'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
        'Content-Type': 'application/json',
      },
    })

    // Procesar la respuesta de OpenAI
    const rawResult = data.choices[0].message.content
    const cleanedResults = JSON.parse(rawResult.replace(/```json|```/g, '').trim())

    await photosService.addMetadata(cleanedResults)

    // Calcular el costo
    const tokensUsed = data.usage.total_tokens
    const costInEur = tokensUsed * COST_PER_TOKEN_EUR

    // Retornar la respuesta
    return {
      results: cleanedResults,
      cost: {
        tokensUsed,
        costInEur: costInEur.toFixed(6),
      },
    }
  }
}
