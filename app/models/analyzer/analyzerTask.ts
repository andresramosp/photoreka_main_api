import { ModelType } from './analyzerProcess.js'
import AnalyzerProcess from './analyzerProcess.js'
import Photo from '../photo.js'
import PhotoImage from './photoImage.js'
import _ from 'lodash'

export abstract class AnalyzerTask {
  declare name: string
  declare model: ModelType
  declare data: any

  // Métodos abstractos que todas las tareas deben implementar
  abstract prepare(process: AnalyzerProcess): Promise<Photo[] | PhotoImage[]>
  abstract process(process: AnalyzerProcess, pendingPhotos: Photo[] | PhotoImage[]): Promise<void>
  abstract commit(): Promise<void>

  getName() {
    return _.startCase(_.toLower(this.name))
  }

  toJSON() {
    return { name: this.name }
  }
}
