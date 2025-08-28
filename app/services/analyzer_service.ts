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
import { packages } from '../analyzer_packages.js'
import { VisionDescriptionTask } from '#models/analyzer/visionDescriptionTask'
import { VisionTopologicalTask } from '#models/analyzer/visionTopologicalTask'
import { TagTask } from '#models/analyzer/tagTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { MetadataTask } from '#models/analyzer/metadataTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import { VisualColorEmbeddingTask } from '#models/analyzer/visualColorEmbeddingTask'
import { VisualDetectionTask } from '#models/analyzer/visualDetectionTask'
import { GlobalEmbeddingsTagsTask } from '#models/analyzer/globalEmbeddingsTagsTask'

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
    await invalidateCache(`getPhotosIdsForSearch${finalUserId}`)

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

    // CAMBIO: Usar stages directamente en lugar de getTaskList
    const pkg = packages.find((p) => p.id === this.process.packageId)
    if (!pkg || !pkg.stages) {
      throw new Exception(`Package ${this.process.packageId} not found or has no stages`)
    }

    // Asignar isPreprocess al proceso
    this.process.isPreprocess = pkg.isPreprocess || false

    // Ejecutar stages directamente
    await this.executeStages(pkg.stages)

    await HealthPhotoService.updateSheetWithHealth(this.process)

    const hasFailed = this.hasFailedPhotos()

    // Determinar si el package es de preproceso usando la propiedad del proceso
    const finalStage = hasFailed ? 'failed' : 'finished'

    await this.changeStage('***  Proceso Completado ***', finalStage)

    // Usar el userId del proceso para invalidar cache
    const processUserId = this.process.userId?.toString()
    await invalidateCache(`getPhotos_${processUserId}`)
    await invalidateCache(`getPhotosIdsForSearch${processUserId}`)

    // Limpiar cache de health solo si se precargó
    if (this.process.mode === 'retry_process') {
      this.process.clearHealthCache()
    }

    this.handleAutoRetry()

    return { hasFailed, processId: this.process.id }
  }

  /**
   * Ejecuta una lista de stages secuencialmente
   */
  private async executeStages(stages: any[], level: number = 0): Promise<void> {
    for (const stage of stages) {
      try {
        await this.executeStage(stage, level)
      } catch (error) {
        const stageDescription = `stage ${stage.type} (${stage.tasks?.length || 0} items)`
        logger.error(`Error en ${stageDescription}:`, error)
      }
    }
  }

  /**
   * Ejecuta un stage (parallel o sequential)
   */
  private async executeStage(stage: any, level: number): Promise<void> {
    const indent = '  '.repeat(level)
    const stageType = stage.type || 'unknown'
    const stageDescription = `${stageType.toUpperCase()} STAGE (${stage.tasks?.length || 0} items)`

    await this.changeStage(
      `${indent}*** Iniciando ${stageDescription} *** | ${this.process.mode.toUpperCase()}`
    )

    if (stage.type === 'parallel') {
      // Ejecutar todas las tasks/stages en paralelo
      const parallelPromises = stage.tasks.map(async (item: any) => {
        if (this.isTaskDefinition(item)) {
          const task = this.createTask(item)
          await this.executeSingleTask(task, level + 1, true)
        } else {
          await this.executeStage(item, level + 1)
        }
      })

      await Promise.all(parallelPromises)
    } else if (stage.type === 'sequential') {
      // Ejecutar las tasks/stages secuencialmente
      for (const item of stage.tasks) {
        if (this.isTaskDefinition(item)) {
          const task = this.createTask(item)
          await this.executeSingleTask(task, level + 1)
        } else {
          await this.executeStage(item, level + 1)
        }
      }
    }

    await this.changeStage(`${indent}*** ${stageDescription} completado ***`)
  }

  /**
   * Ejecuta una tarea individual
   */
  private async executeSingleTask(
    task: any,
    level: number,
    isParallel: boolean = false
  ): Promise<void> {
    const indent = '  '.repeat(level)
    const taskName = task.getName()
    const executionType = isParallel ? 'paralelo' : 'secuencial'

    const pendingPhotos = await task.prepare(this.process)

    if (pendingPhotos.length) {
      if (!isParallel) {
        await this.changeStage(
          `${indent}*** Iniciando tarea ${executionType} *** | ${taskName} | Fotos: ${pendingPhotos.length} | ${this.process.mode.toUpperCase()}`,
          task.name
        )
      }

      logger.info(
        `${indent}-> Ejecutando ${taskName} en ${executionType} | Fotos: ${pendingPhotos.length}`
      )
      await task.process(pendingPhotos, this.process)
      logger.info(`${indent}-> Completado ${taskName}`)

      if (!isParallel) {
        await this.changeStage(`${indent}*** Tarea ${executionType} completada *** | ${taskName}`)
      }
    } else {
      logger.info(`${indent}-> Saltando ${taskName} (sin fotos pendientes)`)
    }
  }

  /**
   * Determina si un item es una definición de tarea (no una instancia)
   */
  private isTaskDefinition(item: any): boolean {
    return (
      item && typeof item === 'object' && item.name && item.type && !item.getName // No es una instancia de tarea
    )
  }

  /**
   * Crea una instancia de tarea desde su definición
   */
  private createTask(taskData: any): any {
    let task: any
    switch (taskData.type) {
      case 'VisionDescriptionTask':
        task = new VisionDescriptionTask(this.process)
        break
      case 'VisionTopologicalTask':
        task = new VisionTopologicalTask(this.process)
        break
      case 'TagTask':
        task = new TagTask(this.process)
        break
      case 'ChunkTask':
        task = new ChunkTask(this.process)
        break
      case 'MetadataTask':
        task = new MetadataTask(this.process)
        break
      case 'VisualEmbeddingTask':
        task = new VisualEmbeddingTask(this.process)
        break
      case 'VisualColorEmbeddingTask':
        task = new VisualColorEmbeddingTask(this.process)
        break
      case 'VisualDetectionTask':
        task = new VisualDetectionTask(this.process)
        break
      case 'GlobalEmbeddingsTagsTask':
        task = new GlobalEmbeddingsTagsTask(this.process)
        break
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }

    Object.assign(task, taskData)
    return task
  }

  /**
   * Obtiene una descripción legible del item para logging
   */
  private getItemDescription(item: any): string {
    if (this.isTaskDefinition(item)) {
      return `tarea ${item.name}`
    } else if (item.type && item.tasks) {
      return `stage ${item.type} (${item.tasks.length} items)`
    } else {
      return 'item desconocido'
    }
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
