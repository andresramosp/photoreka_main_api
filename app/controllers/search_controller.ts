import type { HttpContext } from '@adonisjs/core/http'

import PhotosService from '#services/photos_service'
import ws from '#services/ws'

export default class SearchController {
  /**
   * Handle the upload of multiple photos
   */

  public async search({ request, response }: HttpContext) {
    try {
      const photosService = new PhotosService()
      const query = request.body()

      const stream = photosService.search(query, query.searchType, {
        quickSearch: query.isQuickSearch,
        withInsights: query.withInsights, // solo de pago
      })

      for await (const result of stream) {
        ws.io?.emit(result.type, result.data)
      }

      return response.ok({ message: 'Search process initiated' })
    } catch (error) {
      console.error('Error fetching photos:', error)
      ws.io?.emit('searchError', { message: 'Error fetching photos' })
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchTags({ response, request }: HttpContext) {
    try {
      const photosService = new PhotosService()

      const query = request.body()

      const result = await photosService.searchByTags(query)

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
