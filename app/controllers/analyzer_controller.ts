// @ts-nocheck

import type { HttpContext } from '@adonisjs/core/http'
import AnalyzerService from '#services/analyzer_service'
import ws from '#services/ws'
import Photo from '#models/photo'
import PhotoManager from '../managers/photo_manager.js'

const analysisProcesses = new Map<string, AsyncGenerator>()

export default class AnalyzerController {
  public async analyze({ request, response }: HttpContext) {
    const analyzerService = new AnalyzerService()
    const photoManager = new PhotoManager()

    try {
      const { userId, packageId, processId, mode } = request.body()
      const photos = await photoManager._getPhotosByUser(userId)

      if (photos.length) {
        await analyzerService.initProcess(photos, packageId, mode)
        // await analyzerService.resumeProcess(photos, 38)

        if (!analysisProcesses.has(userId)) {
          const process = analyzerService.run()
          analysisProcesses.set(userId, process)

          this.handleAnalysisStream(userId, process)
          return response.ok({ message: 'Analysis started', userId })
        }
      }

      return response.ok({ message: 'Nothing to analyze', userId })
    } catch (error) {
      console.error(error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }

  private async handleAnalysisStream(userId: string, stream: AsyncGenerator) {
    for await (const result of stream) {
      ws.io?.emit(result.type, result.data) // .to(userId) para Emitir solo a este usuario
    }

    // Cuando termina el análisis, limpiar el proceso de la memoria
    analysisProcesses.delete(userId)
  }
}
