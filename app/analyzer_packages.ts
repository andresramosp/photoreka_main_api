import { AnalyzerTask, VisionTask, TagTask, ChunkTask } from '#models/analyzer/analyzerTask'
import {
  MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_AREAS,
  MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED,
  MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED,
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
        overwrite: false,
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
        overwrite: false,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        overwrite: false,
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
        overwrite: true, // significa que cogemos incluso las fotos que ya tienen el campo relleno
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
        overwrite: false,
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
      //   overwrite: false,
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
        overwrite: false,
        descriptionSourceFields: ['context', 'story'],
      },
      // {
      //   name: 'Etiquetado y Embeddings de Topology',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
      //   overwrite: false,
      //   descriptionSourceFields: ['topology'],
      // },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        overwrite: false,
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
    id: 'advanced_tags_remake',
    tasks: [
      {
        name: 'Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        overwrite: true, // Sobreescribimos la primera vez
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        overwrite: false,
        descriptionSourceFields: ['topology'],
      },
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
        prompts: [MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED],
        overwrite: false,
        imagesPerBatch: 16,
        resolution: null,
        promptDependentField: 'context',
        promptsTarget: ['topology'],
      },
      {
        name: 'Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        overwrite: false,
        descriptionSourceFields: ['topology'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        overwrite: false,
        descriptionSourceFields: ['topology'],
        descriptionsChunksMethod: {
          topology: 'split_by_pipes',
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
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_AREAS],
        imagesPerBatch: 4,
        overwrite: false,
        resolution: 'low',
        promptDependentField: null,
        promptsTarget: ['topology'],
      },
      {
        name: 'Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        overwrite: false,
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        descriptionSourceFields: ['topology'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['topology'],
        descriptionsChunksMethod: {
          topology: 'split_by_props',
        },
      },
    ],
  },
  {
    id: 'basic_tags_remake',
    tasks: [
      {
        name: 'Re-Etiquetado y Embeddings de Context + Story',
        type: 'TagTask',
        overwrite: true, // significa que cogemos incluso las fotos que ya tienen el campo relleno
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        descriptionSourceFields: ['context', 'story'],
      },
    ],
  },
  {
    id: 'topological_tags_remake',
    tasks: [
      {
        name: 'Re-Etiquetado y Embeddings de Topology',
        type: 'TagTask',
        model: 'GPT',
        overwrite: true, // significa que cogemos incluso las fotos que ya tienen el campo relleno
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
        descriptionSourceFields: ['topology'],
      },
    ],
  },
  {
    id: 'artistic_upgrade',
    tasks: [
      {
        name: 'Análisis Artistic',
        type: 'VisionTask',
        model: 'Molmo',
        sequential: true,
        prompts: [MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED],
        overwrite: false,
        imagesPerBatch: 16,
        resolution: null,
        promptDependentField: 'context',
        promptsTarget: ['artistic'],
      },
      {
        name: 'Etiquetado y Embeddings de Artistic',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
        overwrite: false,
        descriptionSourceFields: ['artistic'],
      },
      {
        name: 'Segmentación y Embeddings',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        overwrite: false,
        descriptionSourceFields: ['artistic'],
        descriptionsChunksMethod: {
          artistic: 'split_by_size',
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
