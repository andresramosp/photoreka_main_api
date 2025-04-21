// @ts-nocheck

import AnalyzerProcess, { AnalyzerMode, StageType } from '#models/analyzer/analyzerProcess'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import { getTaskList } from '../analyzer_packages.js'
import Logger, { LogLevel } from '../utils/logger.js'
import PhotoImageService from './photo_image_service.js'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

export default class AnalyzerProcessRunner {
  private process: AnalyzerProcess
  private modelsService: ModelsService
  private photoImageService: PhotoImageService

  constructor() {
    this.process = new AnalyzerProcess()
    this.modelsService = new ModelsService()
    this.photoImageService = PhotoImageService.getInstance()
  }

  public async initProcess(
    userPhotos: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'first',
    processId?: number
  ) {
    logger.debug(`Iniciando proceso en modo ${mode} con paquete ${packageId}`)

    if (mode === 'retry' && processId) {
      this.process = await AnalyzerProcess.query()
        .where('id', processId)
        .preload('photos')
        .firstOrFail()
    }

    await this.process.initialize(userPhotos, packageId, mode)
    await this.changeStage(
      `Proceso Iniciado | Paquete: ${packageId} | ${this.process.photos.length} fotos`,
      'vision_tasks'
    )
  }

  public async *run() {
    if (!this.process || !this.process.tasks) {
      throw new Exception('[ERROR] No process found')
    }

    for (const task of this.process.tasks) {
      try {
        await this.changeStage(`Preparando tarea: ${task.name}`)
        await task.prepare(this.process)

        const pendingPhotos = await task.getPendingPhotos(this.process)
        if (pendingPhotos.length > 0) {
          await this.changeStage(`Procesando tarea: ${task.name}`)
          await task.process(this.process, pendingPhotos)
        }

        await this.changeStage(`Guardando resultados de: ${task.name}`)
        await task.commit()

        await this.changeStage(`Tarea completada: ${task.name}`)
      } catch (error) {
        logger.error(`Error en tarea ${task.name}:`, error)
        // Manejar errores y actualizar estado de fotos fallidas
      }
    }

    await this.changeStage('Proceso Completado', 'finished')
    yield { type: 'analysisComplete', data: { costs: [] } }
  }

  private async changeStage(message: string, nextStage: string = null) {
    logger.info(message)
    if (nextStage) {
      this.process.currentStage = nextStage
      await this.process.save()
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
