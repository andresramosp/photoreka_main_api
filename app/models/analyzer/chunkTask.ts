import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType } from '#models/photo'
import { AnalyzerTask } from './analyzerTask.js'

export type SplitMethod =
  | { type: 'split_by_props' }
  | { type: 'split_by_pipes' }
  | { type: 'split_by_size'; maxLength: number }

export class ChunkTask extends AnalyzerTask {
  declare descriptionSourceFields: DescriptionType[]
  declare descriptionsChunksMethod: Record<DescriptionType, SplitMethod>
  declare data: Record<string, DescriptionChunk[]>

  public async commit() {
    // TODO
  }
}
