import type { HttpContext } from '@adonisjs/core/http'

import ws from '#services/ws'
import SearchTextService from '#services/search_text_service'
import SearchPhotoService from '#services/search_photo_service'
import ModelsService from '#services/models_service'

export default class SearchController {
  /**
   * Handle the upload of multiple photos
   */

  public async searchSemanticSync({ request, response, auth }: HttpContext) {
    const user = auth.use('api').user!
    try {
      const searchService = new SearchTextService()
      const query = request.body()

      const result = await searchService.searchSemanticSync(query.description, user.id, {
        searchMode: query.options.searchMode,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        minMatchScore: query.options.minMatchScore,
        minResults: query.options.minResults,
        collections: query.options.collections,
        visualAspects: query.options.visualAspects,
      })

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchSemanticStream({ request, response, auth }: HttpContext) {
    const user = auth.use('api').user!
    try {
      const searchService = new SearchTextService()
      const query = request.body()

      const stream = searchService.searchSemanticStream(query.description, user.id, {
        searchMode: query.options.searchMode,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        minMatchScore: query.options.minMatchScore,
        minResults: query.options.minResults,
        collections: query.options.collections,
        visualAspects: query.options.visualAspects,
      })

      for await (const result of stream) {
        ws.io?.to(user.id.toString()).emit(result.type, result.data)
      }

      return response.ok({ message: 'Search process initiated' })
    } catch (error) {
      console.error('Error fetching photos:', error)
      ws.io?.to(user.id.toString()).emit('searchError', { message: 'Error fetching photos' })
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchByTagsSync({ response, request, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchTextService()

      const query = request.body()

      const result = await searchService.searchByTagsSync(
        {
          included: query.included,
          excluded: query.excluded,
          pageSize: query.options.pageSize,
          iteration: query.options.iteration,
          searchMode: query.options.searchMode,
          collections: query.options.collections,
          visualAspects: query.options.visualAspects,
        },
        user.id
      )

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchTopologicalSync({ response, request, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchTextService()

      const query = request.body()

      const result = await searchService.searchTopologicalSync(query, user.id, {
        left: query.left,
        right: query.right,
        middle: query.middle,
        pageSize: query.options.pageSize,
        iteration: query.options.iteration,
        searchMode: query.options.searchMode,
        collections: query.options.collections,
        visualAspects: query.options.visualAspects,
      })

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async searchByPhotos({ response, request, auth }: HttpContext) {
    try {
      const user = auth.use('api').user!
      const searchService = new SearchPhotoService()

      const query: any = request.body()

      const result = await searchService.searchByPhotos(query, user.id)

      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
