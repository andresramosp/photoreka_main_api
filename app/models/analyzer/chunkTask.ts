import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType } from '#models/photo'
import { SplitMethods } from '../../analyzer_packages.js'
import { AnalyzerTask } from './analyzerTask.js'

export class ChunkTask extends AnalyzerTask {
  declare descriptionSourceFields: DescriptionType[]
  declare descriptionsChunksMethod: Record<DescriptionType, SplitMethods>
  declare data: Record<string, DescriptionChunk[]>

  public async commit() {
    // TODO
  }
}
