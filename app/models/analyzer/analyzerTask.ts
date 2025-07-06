import { ModelType } from './analyzerProcess.js'
import AnalyzerProcess from './analyzerProcess.js'
import Photo from '../photo.js'
import PhotoImage from './photoImage.js'
import _ from 'lodash'
import PhotoImageService from '#services/photo_image_service'
import Logger, { LogLevel } from '../../utils/logger.js'
import ModelsService from '#services/models_service'
import HealthPhotoService from '#services/health_photo_service'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

export abstract class AnalyzerTask {
  declare name: string
  declare model: ModelType
  declare data: any
  declare needsImage: boolean
  declare useGuideLines: boolean
  declare analyzerProcess: AnalyzerProcess
  declare onlyIfNeeded: boolean
  declare checks: string[]

  declare modelsService: ModelsService

  constructor(analyzerProcess: AnalyzerProcess) {
    this.analyzerProcess = analyzerProcess
    this.modelsService = new ModelsService()
  }

  async prepare(process: AnalyzerProcess): Promise<Photo[] | PhotoImage[]> {
    let targetPhotos: Photo[]

    if (process.mode === 'retry_process') {
      const allPhotos = process.photos
      targetPhotos = []

      for (const photo of allPhotos) {
        const health = await HealthPhotoService.photoHealth(photo.id)

        const isComplete = this.checks.every((checkPattern) => {
          if (checkPattern.includes('*')) {
            const regex = new RegExp('^' + checkPattern.replace('*', '\\d+') + '$')
            return health.checks.filter((c) => regex.test(c.label)).every((c) => c.ok)
          } else {
            const check = health.checks.find((c) => c.label === checkPattern)
            return check ? check.ok : false
          }
        })

        if (!isComplete) targetPhotos.push(photo)
      }

      logger.info(`[${this.name}] Fotos pendientes: ${targetPhotos.length}`)
    } else {
      // En cualquier otro modo procesamos todas las fotos
      targetPhotos = process.photos
      logger.info(`[${this.name}] Procesando todas las fotos (${targetPhotos.length})`)
    }

    if (targetPhotos.length === 0) return []

    if (this.needsImage) {
      const photoImages = await PhotoImageService.getInstance().getPhotoImages(
        process,
        this.useGuideLines
      )
      return photoImages.filter((pi) => targetPhotos.some((p) => p.id === pi.photo.id))
    } else {
      return targetPhotos
    }
  }

  abstract process(pendingPhotos: Photo[] | PhotoImage[]): Promise<void>
  abstract commit(batch?: any[]): Promise<void>

  getName() {
    return _.startCase(_.toLower(this.name))
  }

  toJSON() {
    return { name: this.name }
  }
}
