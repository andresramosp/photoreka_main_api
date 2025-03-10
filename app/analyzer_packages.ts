import { AnalyzerTask, VisionTask, TagTask, ChunkTask } from '#models/analyzer/analyzerTask'
import {
  SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED,
  SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
  SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
} from './utils/ModelsMessages.js'

export const packages = [
  {
    id: 'advanced',
    tasks: [
      {
        name: 'Análisis Context + Story',
        type: 'VisionTask',
        model: 'GPT',
        prompts: [SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        overwrite: false,
        resolution: 'high',
        imagesPerBatch: 6,
        promptDependentField: null,
        promptsTarget: ['context', 'story'],
      },
      {
        name: 'Análisis Topológico',
        type: 'VisionTask',
        model: 'Molmo',
        prompts: [SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED],
        overwrite: false,
        imagesPerBatch: 0,
        resolution: null,
        promptDependentField: 'context',
        promptsTarget: ['topology'],
      },
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',
        prompt: SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        overwrite: false,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        prompt: SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        overwrite: false,
        descriptionSourceFields: ['topology'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        overwrite: false,
        descriptionsChunksMethod: {
          context: 'split_by_size',
          story: 'split_by_size',
          topology: 'split_by_pipes',
        },
      },
    ],
  },
]

export const getTaskList = (packageId: string): AnalyzerTask[] => {
  const pkg = packages.find((p) => p.id === packageId)
  if (!pkg) {
    throw new Error(`Package with id ${packageId} not found`)
  }
  return pkg.tasks.map((taskData) => {
    let task: AnalyzerTask
    switch (taskData.type) {
      case 'VisionTask':
        task = new VisionTask()
        break
      case 'TagTask':
        task = new TagTask()
        break
      case 'ChunkTask':
        task = new ChunkTask()
        break
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }
    Object.assign(task, taskData)
    return task
  })
}
