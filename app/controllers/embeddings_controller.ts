import { HttpContext } from '@adonisjs/core/http'
import EmbeddingService from '#services/embedding_service'

export default class EmbeddingController {
  async getEmbeddings({ request, response }: HttpContext) {
    try {
      const tags = request.input('tags') as string[]

      if (!Array.isArray(tags) || tags.length === 0) {
        return response.badRequest({ error: 'Input must be a non-empty array of strings.' })
      }

      const embeddings = await EmbeddingService.generateEmbeddings(tags)

      return response.ok({ embeddings })
    } catch (error) {
      console.error(error)
      return response.internalServerError({ error: 'Failed to generate embeddings.' })
    }
  }
}
