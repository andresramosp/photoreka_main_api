// @ts-nocheck

import type { HttpContext } from '@adonisjs/core/http'
import AnalyzerService from '#services/analyzer_service'
import Photo from '#models/photo'
import PhotoManager from '../managers/photo_manager.js'
import Logger from '../utils/logger.js'
import HealthPhotoService from '#services/health_photo_service'
import AnalyzerProcess from '#models/analyzer/analyzerProcess'

const logger = Logger.getInstance('AnalyzerProcess')

export default class AnalyzerController {
  public async analyze({ request, response }: HttpContext) {
    const analyzerService = new AnalyzerService()
    const photoManager = new PhotoManager()

    try {
      const {
        userId,
        packageId,
        processId,
        mode,
        fastMode,
        inmediate = true,
        sync = false,
      } = request.body()
      logger.info(
        `Iniciando análisis para usuario ${userId} - Paquete: ${packageId} - Modo: ${mode} - Inmediato: ${inmediate}`
      )

      // Usar consulta optimizada según el modo de análisis
      const photos = await photoManager.getPhotosForAnalysis(mode, processId)

      if (photos.length) {
        await analyzerService.initProcess(photos, packageId, mode, fastMode, processId)

        if (inmediate) {
          if (sync) {
            logger.info(`Ejecutando análisis de forma síncrona para usuario ${userId}`)
            await analyzerService.run()
          } else {
            analyzerService.run()
            logger.info(`Análisis ejecutado inmediatamente para usuario ${userId}`)
          }
        } else {
          logger.info(`Análisis inicializado pero diferido para usuario ${userId}`)
        }

        return response.ok({
          message: inmediate ? 'Analysis started' : 'Analysis initialized',
          userId,
        })
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

      // Aquí puedes devolver los datos que necesites
      // return response.ok(process?.processSheet)
    } catch (error) {
      logger.error('Error obteniendo health:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }
}
