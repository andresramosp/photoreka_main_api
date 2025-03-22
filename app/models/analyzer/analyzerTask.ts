import { ModelType } from './analyzerProcess.js'

export class AnalyzerTask {
  declare name: string
  declare model: ModelType

  toJSON() {
    return { name: this.name }
  }
}
