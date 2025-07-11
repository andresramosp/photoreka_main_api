import type { HttpContext } from '@adonisjs/core/http'

import ws from '#services/ws'
import SearchTextService from '#services/search_text_service'
import SearchPhotoService from '#services/search_photo_service'
import ModelsService from '#services/models_service'

export default class SearchController {
  /**
   * Handle the upload of multiple photos
   */

  public async searchSemantic({ request, response, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchTextService()
      const query = request.body()

      const stream = searchService.searchSemantic(query.description, user.id, {
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

  public async searchByTags({ response, request, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchTextService()

      const query = request.body()

      const stream = searchService.searchByTags(
        {
          included: query.included,
          excluded: query.excluded,
          pageSize: query.options.pageSize,
          iteration: query.options.iteration,
          searchMode: query.options.searchMode,
        },
        user.id
      )

      for await (const result of stream) {
        ws.io?.emit(result.type, result.data)
      }

      return response.ok({ message: 'Search process initiated' })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchTopological({ response, request, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchTextService()

      const query = request.body()

      const stream = searchService.searchTopological(query, user.id, {
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

  public async warmUp({ response }: HttpContext) {
    try {
      const modelService = new ModelsService()

      if (process.env.API_MODELS == 'REMOTE') {
        await Promise.all([
          // modelService.ensureRunPodWarm('embeddings_cpu'),
          modelService.ensureRunPodWarm('logic_gpu'),
        ])
      }

      return response.ok({ result: true })
    } catch (error) {
      console.error('Error warming up:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
