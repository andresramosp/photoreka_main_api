import type { HttpContext } from '@adonisjs/core/http'

import ws from '#services/ws'
import SearchTextService from '#services/search_text_service'
import SearchPhotoService from '#services/search_photo_service'

export default class SearchController {
  /**
   * Handle the upload of multiple photos
   */

  public async searchSemantic({ request, response }: HttpContext) {
    try {
      const searchService = new SearchTextService()
      const query = request.body()

      const stream = searchService.searchSemantic(query.description, {
        searchMode: query.options.searchMode,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        minMatchScore: query.options.minMatchScore,
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

  public async searchByTags({ response, request }: HttpContext) {
    try {
      const searchService = new SearchTextService()

      const query = request.body()

      const stream = searchService.searchByTags({
        included: query.included,
        excluded: query.excluded,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        searchMode: query.options.searchMode,
      })

      for await (const result of stream) {
        ws.io?.emit(result.type, result.data)
      }

      return response.ok({ message: 'Search process initiated' })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchTopological({ response, request }: HttpContext) {
    try {
      const searchService = new SearchTextService()

      const query = request.body()

      const stream = searchService.searchTopological(query, {
        left: query.left,
        right: query.right,
        middle: query.middle,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        searchMode: query.options.searchMode,
      })

      for await (const result of stream) {
        ws.io?.emit(result.type, result.data)
      }

      return response.ok({ message: 'Search process initiated' })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchByPhotos({ response, request }: HttpContext) {
    try {
      const searchService = new SearchPhotoService()

      const query: any = request.body()

      const result = await searchService.searchByPhotos(query)

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
