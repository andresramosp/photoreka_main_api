// @ts-nocheck

import type { HttpContext } from '@adonisjs/core/http'
import AnalyzerService from '#services/analyzer_service'
import ws from '#services/ws'
import Photo from '#models/photo'

const analysisProcesses = new Map<string, AsyncGenerator>()

export default class AnalyzerController {
  public async analyze({ request, response }: HttpContext) {
    const analyzerService = new AnalyzerService()

    try {
      // Obtener los IDs de las imágenes desde el frontend
      const { userId } = request.body()

      // Aqui sacariamos las photos de este usuario
      const photos = (await Photo.all()).filter((photo) => photo.needProcess)

      if (!Array.isArray(photos) || photos.length === 0) {
        return response.badRequest({ message: 'No image IDs provided' })
      }

      if (!userId) {
        return response.badRequest({ message: 'User ID is required' })
      }

      const photosIds = photos.map((photo) => photo.id)

      // Si el usuario ya tiene un análisis en curso, no iniciar otro
      if (!analysisProcesses.has(userId)) {
        const process = analyzerService.analyzeGPTAndMolmo(photosIds)
        analysisProcesses.set(userId, process)

        // Ejecutar el stream y emitir los eventos por WebSocket
        this.handleAnalysisStream(userId, process)
      }

      return response.ok({ message: 'Analysis started', userId })
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
