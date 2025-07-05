import { ModelType } from './analyzerProcess.js'
import AnalyzerProcess from './analyzerProcess.js'
import Photo from '../photo.js'
import PhotoImage from './photoImage.js'
import _ from 'lodash'
import PhotoImageService from '#services/photo_image_service'
import Logger, { LogLevel } from '../../utils/logger.js'
import ModelsService from '#services/models_service'

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

  declare modelsService: ModelsService

  constructor(analyzerProcess: AnalyzerProcess) {
    this.analyzerProcess = analyzerProcess
    this.modelsService = new ModelsService()
  }

  // Métodos abstractos que todas las tareas deben implementar
  async prepare(process: AnalyzerProcess): Promise<Photo[] | PhotoImage[]> {
    const processSheet = process.processSheet
    if (!processSheet) throw new Error('No process sheet initialized.')

    const myTaskState = processSheet[this.name]
    if (!myTaskState) throw new Error(`Task "${this.name}" not found in process sheet.`)

    let candidates = myTaskState.pendingPhotoIds

    if (process.mode == 'retry_process' && candidates.length)
      logger.info(`[${this.name}] Fotos a procesar: ${candidates.length}`)

    if (this.needsImage) {
      const photoImages: PhotoImage[] = await PhotoImageService.getInstance().getPhotoImages(
        process,
        this.useGuideLines
      )
      return photoImages.filter((pi) => candidates.includes(pi.photo.id))
    } else {
      return process.photos.filter((p) => candidates.includes(p.id))
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
