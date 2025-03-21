import { AnalyzerTask, VisionTask, TagTask, ChunkTask } from '#models/analyzer/analyzerTask'
import {
  MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_3_AREAS,
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_3_AREAS_TAGS,
  MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED,
  MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS,
  MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_NOT_PRETRAINED,
  MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED,
  MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED_TAGS,
  MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
  MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
} from './utils/ModelsMessages.js'

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
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['context', 'story'],
        descriptionsChunksMethod: {
          context: 'split_by_size',
          story: 'split_by_size',
        },
      },
    ],
  },
  {
    id: 'basic_tags_remake',
    tasks: [
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        descriptionSourceFields: ['context', 'story'],
      },
    ],
  },
  // TODO: EMBEDDINGS REMAKE!
  {
    id: 'advanced',
    tasks: [
      {
        name: 'Análisis Context + Story',
        type: 'VisionTask',
        model: 'GPT',
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 6,
        promptDependentField: null,
        promptsTarget: ['context', 'story'],
      },
      // {
      //   name: 'Análisis Topológico',
      //   type: 'VisionTask',
      //   model: 'Molmo',
      //   prompts: [MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED],
      //   imagesPerBatch: 1,
      //   resolution: null,
      //   promptDependentField: 'context',
      //   promptsTarget: ['topology'],
      // },
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',

        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        descriptionSourceFields: ['context', 'story'],
      },
      // {
      //   name: 'Etiquetado y Embeddings de Topology',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
      //   descriptionSourceFields: ['topology'],
      // },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['context', 'story'],
        descriptionsChunksMethod: {
          context: 'split_by_size',
          story: 'split_by_size',
          // topology: 'split_by_pipes',
        },
      },
    ],
  },
  {
    id: 'advanced_tags_remake', // esto ya no se establece por lista de tareas, sino a nivel de root.
    mode: 'remake', // OJO
    tasks: [
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        descriptionSourceFields: ['topology'],
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
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_3_AREAS_TAGS],
        imagesPerBatch: 6,
        useGuideLines: true,
        promptDependentField: null,
        promptsTarget: null,
        tagsTarget: 'area',
      },
      // {
      //   name: 'Etiquetado y Embeddings de Topology',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
      //   descriptionSourceFields: ['topology'],
      // },
      // {
      //   name: 'Segmentación y Embeddings',
      //   type: 'ChunkTask',
      //   prompt: null,
      //   model: null,
      //   descriptionSourceFields: ['topology'],
      //   descriptionsChunksMethod: {
      //     topology: 'split_by_props',
      //   },
      // },
    ],
  },
  {
    id: 'topological_upgrade_molmo',
    tasks: [
      {
        name: 'Análisis Topológico',
        type: 'VisionTask',
        model: 'Molmo',
        sequential: true,
        prompts: [MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED_TAGS],
        imagesPerBatch: 16,
        useGuideLines: false,
        promptDependentField: 'context',
        promptsTarget: ['topology'],
      },
      // {
      //   name: 'Etiquetado y Embeddings de Topology',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
      //   descriptionSourceFields: ['topology'],
      // },
      // {
      //   name: 'Segmentación y Embeddings',
      //   type: 'ChunkTask',
      //   prompt: null,
      //   model: null,
      //   descriptionSourceFields: ['topology'],
      //   descriptionsChunksMethod: {
      //     topology: 'split_by_props',
      //   },
      // },
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
