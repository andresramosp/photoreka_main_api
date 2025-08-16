import type { HttpContext } from '@adonisjs/core/http'

import ModelsService from '#services/models_service'

export default class WarmupController {
  public async warmUp({ response, params }: HttpContext) {
    try {
      const modelService = new ModelsService()

      if (process.env.API_MODELS == 'REMOTE') {
        await Promise.all([modelService.ensureRunPodWarm(params.endpointType)])
      }

      return response.ok({ result: true })
    } catch (error) {
      console.error('Error warming up:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
