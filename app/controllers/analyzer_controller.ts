import type { HttpContext } from '@adonisjs/core/http'

import AnalyzerService from '#services/analyzer_service'

export default class AnalyzerController {
  public async analyze({ request, response }: HttpContext) {
    const analyzerService = new AnalyzerService()

    try {
      // Obtener los IDs de las imágenes desde el frontend
      const { photos } = request.body()
      if (!Array.isArray(photos) || photos.length === 0) {
        return response.badRequest({ message: 'No image IDs provided' })
      }

      const photosIds = photos.map((photo) => photo.id)

      const { results, cost } = await analyzerService.analyze(photosIds, 1)

      return response.ok({
        results,
        cost,
      })
    } catch (error) {
      console.error(error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }
}
