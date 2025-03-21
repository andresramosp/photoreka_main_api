import { AnalyzerTask, VisionTask, TagTask, ChunkTask } from '#models/analyzer/analyzerTask'
import {
  MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS,
} from './utils/prompts/descriptions.js'
import {
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS,
  MESSAGE_TAGS_TEXT_EXTRACTION,
} from './utils/prompts/tags.js'

export type SplitMethods = 'split_by_props' | 'split_by_pipes' | 'split_by_size'

export const packages = [
  {
    id: 'basic',
    tasks: [
      {
        name: 'Análisis Context + Story',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 5,
        promptDependentField: null,
        promptsTarget: ['context', 'story'],
      },
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Análisis Visual Accents',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        prompts: [MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS],
        resolution: 'high',
        imagesPerBatch: 8,
        promptDependentField: null,
        promptsTarget: ['visual_accents'],
      },
      {
        name: 'Etiquetado y Embeddings de Visual Accents',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['visual_accents'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['context', 'story', 'visual_accents'],
        descriptionsChunksMethod: {
          context: 'split_by_size',
          story: 'split_by_size',
          visual_accents: 'split_by_pipes',
        },
      },
    ],
  },

  {
    id: 'topological_upgrade_gpt',
    tasks: [
      {
        name: 'Análisis Topológico',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        resolution: 'low',
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS],
        imagesPerBatch: 6,
        useGuideLines: true,
        promptDependentField: null,
        promptsTarget: null,
        tagsTarget: 'area',
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
