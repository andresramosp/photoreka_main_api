import type { HttpContext } from '@adonisjs/core/http'
import sharp from 'sharp'
import axios from 'axios'
import env from '#start/env'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

export default class ImagesController {
  public async processImage({ request, response }: HttpContext) {
    try {
      // Obtener las imágenes del body dinámicamente (image1, image2, ..., image10)
      const images = Array.from({ length: 10 }, (_, i) => `image${i + 1}`)
      const imageFiles = await Promise.all(
        images.map((key) => request.file(key, { extnames: ['jpg', 'jpeg'] }))
      )

      // Filtrar imágenes válidas (omitimos las no enviadas)
      const validImageFiles = imageFiles.filter((file) => file && file.tmpPath)

      // Validar que al menos haya una imagen válida
      if (validImageFiles.length === 0) {
        return response.badRequest({ message: 'At least one valid image file is required' })
      }

      // Procesar y codificar todas las imágenes válidas en Base64
      const base64Images = await Promise.all(
        validImageFiles.map(async (imageFile) => {
          const resizedBuffer = await sharp(imageFile?.tmpPath!)
            .resize({ width: 512, fit: 'inside' })
            .toBuffer()
          return resizedBuffer.toString('base64')
        })
      )

      // Crear el payload con múltiples imágenes
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
                                 'description' (max 70 words): describe the general scene, the environment, what is doing each person and their interactions, and pay special attention to curious or strange details, funny contrasts or optical illusions, that can make this a good street photography.
                                - 'place' (max 2 words): is it a shop? a gym? a street?
                                - 'imageName': name of the image
                                - 'culture' (max 2 words): guessed country and/or culture
                                - 'title' (max 5 words): create a suggestive title for this image
                                - 'people' (array of subjects, like 'woman in red' or 'man with suitcase')
                            `,
              },
              ...base64Images.map((base64Image, index) => ({
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                  detail: 'low',
                  name: `image${index + 1}`,
                },
              })),
            ],
          },
        ],
        max_tokens: 2000, // Ajustar según la cantidad esperada de tokens
      }

      // Enviar solicitud a OpenAI
      const { data } = await axios.post(
        env.get('OPENAI_BASEURL') + '/v1/chat/completions',
        payload,
        {
          headers: {
            'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
            'Content-Type': 'application/json',
          },
        }
      )

      // Procesar la respuesta para extraer los resultados
      const rawResult = data.choices[0].message.content
      const cleanedResults = JSON.parse(rawResult.replace(/```json|```/g, '').trim())

      // Calcular el costo
      const tokensUsed = data.usage.total_tokens
      const costInEur = tokensUsed * COST_PER_TOKEN_EUR

      // Retornar la respuesta con los resultados
      return response.ok({
        results: cleanedResults,
        cost: {
          tokensUsed,
          costInEur: costInEur.toFixed(6),
        },
      })
    } catch (error) {
      console.error(error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }
}
