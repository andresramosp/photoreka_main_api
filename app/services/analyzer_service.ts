// @ts-nocheck

import AnalyzerProcess, { AnalyzerMode } from '#models/analyzer/analyzerProcess'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import Logger, { LogLevel } from '../utils/logger.js'
import PhotoImageService from './photo_image_service.js'
import { invalidateCache } from '../decorators/withCache.js'
import chalk from 'chalk' // ← NUEVO
import PhotoManager from '../managers/photo_manager.js'
import HealthPhotoService from './health_photo_service.js'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

export default class AnalyzerProcessRunner {
  private process: AnalyzerProcess
  private modelsService: ModelsService
  private photoImageService: PhotoImageService
  private photoManager: PhotoManager

  constructor() {
    this.process = new AnalyzerProcess()
    this.modelsService = new ModelsService()
    this.photoManager = new PhotoManager()
    this.photoImageService = PhotoImageService.getInstance()
  }

  /** ────────────────────────────────────
   *  INICIALIZACIÓN Y EJECUCIÓN PRINCIPAL
   * ──────────────────────────────────── */

  public async initProcess(
    userPhotos: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'first',
    fastMode: boolean,
    processId?: number
  ) {
    await invalidateCache(`getPhotos_${1234}`)
    await invalidateCache(`getPhotosIdsByUser_${1234}`)

    if ((mode === 'retry_process' || mode === 'remake_process') && processId) {
      this.process = await AnalyzerProcess.query()
        .where('id', processId)
        .preload('photos')
        .firstOrFail()
    }

    await this.process.initialize(userPhotos, packageId, mode, fastMode)
    await this.changeStage(
      `Proceso Iniciado | Paquete: ${packageId} | Modo ${mode}`,
      'vision_tasks'
    )
  }

  public async run() {
    if (!this.process || !this.process.tasks) throw new Exception('[ERROR] No process found')

    for (const task of this.process.tasks) {
      try {
        const pendingPhotos = await task.prepare(this.process)
        if (pendingPhotos.length) {
          await this.changeStage(
            `*** Iniciando tarea *** | ${task.getName()} | Fotos: ${pendingPhotos.length} | ${this.process.mode.toUpperCase()}`,
            task.name
          )
          await task.process(pendingPhotos, this.process)
          await task.commit(pendingPhotos)
          await this.changeStage(`*** Tarea completada *** | ${task.getName()}`)
        }
      } catch (error) {
        logger.error(`Error en tarea ${task.name}:`, error)
      }
    }

    await HealthPhotoService.updateSheetWithHealth(this.process)

    await this.changeStage('***  Proceso Completado ***', 'finished')
    logger.info(`\n  ${this.process.formatProcessSheet()} \n `)

    await invalidateCache(`getPhotos_${1234}`)
    await invalidateCache(`getPhotosIdsByUser_${1234}`)

    this.handleAutoRetry()
  }

  private async changeStage(message: string, nextStage: string = null) {
    logger.info(message, false)
    if (nextStage) {
      this.process.currentStage = nextStage
      await this.process.save()
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // NUEVO: Función privada para manejar el autoRetry
  private async handleAutoRetry() {
    if (this.process.autoRetry) {
      // Verificar si hay fotos pendientes en alguna tarea
      const sheet = this.process.processSheet || {}
      const hayFallidas = Object.values(sheet).some(
        (task: any) => Array.isArray(task.pendingPhotoIds) && task.pendingPhotoIds.length > 0
      )
      const maxAttempts = this.process.maxAttempts ?? 3
      const attempts = this.process.attempts ?? 0
      if (hayFallidas && attempts < maxAttempts) {
        logger.info(
          `AutoRetry activo: lanzando retry_process automáticamente (hay fotos fallidas, intento ${attempts + 1}/${maxAttempts})...`
        )
        this.process.mode = 'retry_process'
        this.process.attempts = attempts + 1
        await this.process.save()
        this.run()
      } else if (hayFallidas) {
        logger.info(
          `autoRetry: se alcanzó el máximo de intentos (${maxAttempts}). No se lanza retry_process.`
        )
      } else {
        logger.info('autoRetry activo, pero no hay fotos fallidas. No se lanza retry_process.')
      }
    }
  }
}
