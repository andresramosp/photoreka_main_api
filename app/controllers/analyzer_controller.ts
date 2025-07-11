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
  public async analyze({ request, response, auth }: HttpContext) {
    const analyzerService = new AnalyzerService()
    const photoManager = new PhotoManager()

    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const realUserId = user.id.toString()

      const {
        userId, // Este puede venir del body pero usaremos el real del token
        packageId,
        processId,
        mode,
        fastMode,
        inmediate = true,
        sync = false,
      } = request.body()

      logger.info(
        `Iniciando análisis para usuario ${realUserId} - Paquete: ${packageId} - Modo: ${mode} - Inmediato: ${inmediate}`
      )

      // Usar consulta optimizada según el modo de análisis
      const photos = await photoManager.getPhotosForAnalysis(mode, processId, realUserId)

      if (photos.length) {
        await analyzerService.initProcess(photos, packageId, mode, fastMode, processId, realUserId)

        if (inmediate) {
          if (sync) {
            logger.info(`Ejecutando análisis de forma síncrona para usuario ${realUserId}`)
            await analyzerService.run()
          } else {
            analyzerService.run()
            logger.info(`Análisis ejecutado inmediatamente para usuario ${realUserId}`)
          }
        } else {
          logger.info(`Análisis inicializado pero diferido para usuario ${realUserId}`)
        }

        return response.ok({
          message: inmediate ? 'Analysis started' : 'Analysis initialized',
          userId: realUserId,
        })
      }

      logger.info(`No hay fotos para analizar para el usuario ${realUserId}`)
      return response.ok({ message: 'Nothing to analyze', userId: realUserId })
    } catch (error) {
      logger.error('Error en el proceso de análisis:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }

  public async healthForUser({ request, response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const realUserId = user.id

      // Permitir override del userId desde query params para casos específicos
      const queryUserId = request.qs().userId
      const userId = queryUserId ? Number(queryUserId) : realUserId

      if (!userId) return response.badRequest({ message: 'Missing userId' })

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

  public async healthForProcess({ request, response, auth }: HttpContext) {
    const processId = Number(request.qs().processId)
    if (!processId) return response.badRequest({ message: 'Missing processId' })

    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id

      const process = await AnalyzerProcess.query()
        .where('id', processId)
        .where('user_id', userId)
        .first()

      if (!process) {
        return response.notFound({ message: 'AnalyzerProcess not found' })
      }

      await process.load('photos')
      const reports = await HealthPhotoService.updateSheetWithHealth(process)

      // Aquí puedes devolver los datos que necesites
      // return response.ok(process?.processSheet)
    } catch (error) {
      logger.error('Error obteniendo health:', error)
      return response.internalServerError({ message: 'Something went wrong', error: error.message })
    }
  }
}
