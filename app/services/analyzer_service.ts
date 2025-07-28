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
import { has } from 'lodash'

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
    photosForProcess: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'adding',
    fastMode: boolean,
    processId?: number,
    userId?: string
  ) {
    const finalUserId = userId

    await invalidateCache(`getPhotos_${finalUserId}`)
    await invalidateCache(`getPhotosIdsByUser_${finalUserId}`)

    if ((mode === 'retry_process' || mode === 'remake_process') && processId) {
      this.process = await AnalyzerProcess.query()
        .where('id', processId)
        .preload('photos')
        .firstOrFail()

      // Para retry/remake, usar el userId original del proceso
      await this.process.initialize(
        photosForProcess,
        packageId,
        mode,
        fastMode,
        this.process.userId!!
      )
    } else {
      // Para nuevos procesos, usar el userId pasado como parámetro
      await this.process.initialize(
        photosForProcess,
        packageId,
        mode,
        fastMode,
        Number(finalUserId)
      )
    }

    await this.changeStage(
      `Proceso Iniciado | Paquete: ${packageId} | Modo ${mode}`,
      'vision_tasks'
    )
  }

  /**
   * Ejecuta todas las tasks: primero las no globales, luego las globales
   */
  public async runAll() {
    const { hasFailed } = await this.run()
    await this.runGlobal()
    return { hasFailed }
  }

  /**
   * Ejecuta solo las tasks que NO son globales (isGlobal === false)
   */
  public async run() {
    if (!this.process || !this.process.tasks) throw new Exception('[ERROR] No process found')

    const tasks = this.process.tasks.filter((t) => !t.isGlobal)
    if (tasks.length === 0) {
      logger.info('No hay tareas para ejecutar en este proceso')
      return { hasFailed: false, processId: this.process.id }
    }
    // Precargar health en paralelo solo si es retry_process
    if (this.process.mode === 'retry_process') {
      await this.changeStage('*** Precargando health de fotos ***')
      await this.process.preloadPhotoHealth()
    }

    for (const task of tasks) {
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

    const hasFailed = this.hasFailedPhotos()

    // Determinar si el package es de preproceso usando la propiedad del proceso
    const finalStage = hasFailed ? 'failed' : 'finished'

    await this.changeStage('***  Proceso Completado ***', finalStage)

    // Usar el userId del proceso para invalidar cache
    const processUserId = this.process.userId?.toString()
    await invalidateCache(`getPhotos_${processUserId}`)
    await invalidateCache(`getPhotosIdsByUser_${processUserId}`)

    // Limpiar cache de health solo si se precargó
    if (this.process.mode === 'retry_process') {
      this.process.clearHealthCache()
    }

    this.handleAutoRetry()

    return { hasFailed, processId: this.process.id }
  }

  /**
   * Ejecuta solo las tasks globales (isGlobal === true)
   * Estas tasks no requieren pendingPhotos, solo process() y commit()
   */
  public async runGlobal() {
    if (!this.process || !this.process.tasks) throw new Exception('[ERROR] No process found')

    for (const task of this.process.tasks.filter((t) => t.isGlobal)) {
      try {
        await this.changeStage(
          `*** Iniciando tarea GLOBAL *** | ${task.getName()} | ${this.process.mode.toUpperCase()}`,
          task.name
        )
        await task.process(null, this.process) // process solo recibe el proceso
        await task.commit() // commit sin argumentos
        await this.changeStage(`*** Tarea GLOBAL completada *** | ${task.getName()}`)
      } catch (error) {
        logger.error(`Error en tarea GLOBAL ${task.name}:`, error)
      }
    }
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

  private hasFailedPhotos = () => {
    const sheet = this.process.processSheet || {}
    return Object.values(sheet).some(
      (task: any) => Array.isArray(task.pendingPhotoIds) && task.pendingPhotoIds.length > 0
    )
  }

  // NUEVO: Función privada para manejar el autoRetry
  private async handleAutoRetry() {
    if (this.process.autoRetry) {
      // Verificar si hay fotos pendientes en alguna tarea
      const hayFallidas = this.hasFailedPhotos()
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
          `autoRetry: se alcanzó el máximo de intentos (${maxAttempts}). El proceso se marca como 'finished'.`
        )
        this.process.currentStage = 'finished'
        await this.process.save()
      } else {
        logger.info('autoRetry activo, pero no hay fotos fallidas. No se lanza retry_process.')
      }
    }
  }
}
