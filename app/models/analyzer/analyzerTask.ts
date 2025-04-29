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
  declare dependsOn: string
  declare analyzerProcess: AnalyzerProcess

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
    const initialCandidates = [...candidates] // Para comparar luego

    if (this.dependsOn) {
      const dependsTaskState = processSheet[this.dependsOn]
      if (!dependsTaskState)
        throw new Error(`DependsOn task "${this.dependsOn}" not found in process sheet.`)

      const pendingInDepends = new Set(dependsTaskState.pendingPhotoIds)

      // Excluir fotos que siguen pendientes en la tarea de dependencia
      candidates = candidates.filter((photoId) => !pendingInDepends.has(photoId))

      const excludedIds = initialCandidates.filter((id) => pendingInDepends.has(id))

      if (excludedIds.length) {
        logger.info(
          `[${this.name}] Fotos excluidas por dependencia de ${this.dependsOn}: ${excludedIds.join(', ')}`
        )
      }
    }

    if (process.mode == 'retry' && candidates.length)
      logger.info(`[${this.name}] Fotos a procesar: ${candidates.join(', ')}`)

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
  abstract commit(): Promise<void>

  getName() {
    return _.startCase(_.toLower(this.name))
  }

  toJSON() {
    return { name: this.name }
  }
}
