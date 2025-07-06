// @ts-nocheck

import type { HttpContext } from '@adonisjs/core/http'
import AnalyzerService from '#services/analyzer_service'
import ws from '#services/ws'
import Photo from '#models/photo'
import PhotoManager from '../managers/photo_manager.js'
import Logger from '../utils/logger.js'
import { invalidateCache } from '../decorators/withCache.js'
import AnalyzerProcessRunner from '#services/analyzer_service'
import HealthPhotoService from '#services/health_photo_service'
import AnalyzerProcess from '#models/analyzer/analyzerProcess'

const analysisProcesses = new Map<string, AsyncGenerator>()
const logger = Logger.getInstance('AnalyzerProcess')

export default class AnalyzerController {
  public async analyze({ request, response }: HttpContext) {
    const analyzerService = new AnalyzerService()
    const photoManager = new PhotoManager()

    try {
      const { userId, packageId, processId, mode } = request.body()
      logger.info(
        `Iniciando análisis para usuario ${userId} - Paquete: ${packageId} - Modo: ${mode}`
      )

      const photos = await photoManager.getPhotos(userId, false)

      if (photos.length) {
        await analyzerService.initProcess(photos, packageId, mode, processId)

        if (!analysisProcesses.has(userId)) {
          const process = analyzerService.run()

          analysisProcesses.set(userId, process)

          this.handleAnalysisStream(userId, process)
          return response.ok({ message: 'Analysis started', userId })
        }
      }

      logger.info(`No hay fotos para analizar para el usuario ${userId}`)
      return response.ok({ message: 'Nothing to analyze', userId })
    } catch (error) {
      logger.error('Error en el proceso de análisis:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }

  public async healthForUser({ request, response }: HttpContext) {
    const userId = Number(request.qs().userId)
    if (!userId) return response.badRequest({ message: 'Missing userId' })

    try {
      const reports = await HealthPhotoService.healthForUser(userId)

      return response.ok({
        userId,
        ok: reports.every((r) => r.ok),
        reports,
      })
    } catch (error) {
      logger.error('Error obteniendo health:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }

  public async healthForProcess({ request, response }: HttpContext) {
    const processId = Number(request.qs().processId)
    if (!processId) return response.badRequest({ message: 'Missing processId' })

    try {
      const process = await AnalyzerProcess.find(processId)
      await process?.load('photos')
      const reports = await HealthPhotoService.updateSheetWithHealth(process)

      // Para devolver la sheet hay que hacer que updateSheetWithHealth distribuya las fotos entre pending y complete

      // await process?.refresh()

      // return response.ok(process?.processSheet)
    } catch (error) {
      logger.error('Error obteniendo health:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }

  private async handleAnalysisStream(userId: string, stream: AsyncGenerator) {
    try {
      for await (const result of stream) {
        ws.io?.emit(result.type, result.data)
      }
      logger.info(`Análisis completado para usuario ${userId}`)
    } catch (error) {
      logger.error(`Error en el stream de análisis para usuario ${userId}:`, error)
    } finally {
      analysisProcesses.delete(userId)
    }
  }
}
