import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { TagTask } from '#models/analyzer/tagTask'
import { VisionTask } from '#models/analyzer/visionTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import {
  MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS,
  MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS,
  MESSAGE_ANALYZER_MOLMO_VISUAL_ACCENTS,
} from './utils/prompts/descriptions.js'
import {
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS,
  MESSAGE_TAGS_TEXT_EXTRACTION,
} from './utils/prompts/tags.js'

export const packages = [
  {
    // Context + Story + Accents en una sola llamada GPT
    id: 'basic_1',
    tasks: [
      // {
      //   // 0,0048 por foto (0,0024 con Batch API.)
      //   name: 'vision_context_story_accents',
      //   type: 'VisionTask',
      //   model: 'GPT',
      //   sequential: false,
      //   targetFieldType: 'descriptions',
      //   prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS],
      //   resolution: 'high',
      //   imagesPerBatch: 4,
      //   promptDependentField: null,
      // },
      // {
      //   name: 'tags_context_story',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
      //   descriptionSourceFields: ['context', 'story'],
      // },
      // {
      //   name: 'tags_visual_accents',
      //   type: 'TagTask',
      //   model: 'GPT',
      //   prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
      //   descriptionSourceFields: ['visual_accents'],
      // },
      // {
      //   name: 'chunks_context_story_visual_accents',
      //   type: 'ChunkTask',
      //   prompt: null,
      //   model: null,
      //   descriptionSourceFields: ['context', 'story', 'visual_accents'],
      //   descriptionsChunksMethod: {
      //     context: { type: 'split_by_size', maxLength: 250 },
      //     story: { type: 'split_by_size', maxLength: 250 },
      //     visual_accents: { type: 'split_by_size', maxLength: 15 },
      //   },
      // },
      // {
      //   name: 'visual_embedding_task',
      //   type: 'VisualEmbeddingTask',
      // },
    ],
  },
  // Basic context-story + visual_accents GPT separados
  {
    // 0,0082 por foto (0,0061 con Batch API aprox.)
    id: 'basic_2',
    tasks: [
      {
        name: 'vision_context_story',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        targetFieldType: 'descriptions',
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 4,
        promptDependentField: null,
      },
      // TODO: intentar mandar visual_accents con 1000px
      {
        // xxxx por foto (xxxx con Batch API aprox.)
        name: 'vision_visual_accents',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        targetFieldType: 'descriptions',
        prompts: [MESSAGE_ANALYZER_GPT_VISUAL_ACCENTS],
        resolution: 'high',
        imagesPerBatch: 8,
        promptDependentField: null,
      },
      {
        name: 'tags_context_story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'tags_visual_accents',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['visual_accents'],
      },
      {
        name: 'chunks_context_story_visual_accents',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['context', 'story', 'visual_accents'],
        descriptionsChunksMethod: {
          context: { type: 'split_by_size', maxLength: 300 },
          story: { type: 'split_by_size', maxLength: 300 },
          visual_accents: { type: 'split_by_size', maxLength: 15 },
        },
      },
    ],
  },
  {
    // Context Story GPT + Accents Molmo
    // Habria que arreglar tema crops + revisar pequeñas alucinaciones (que no saque elementos borrosos o distantes). Plantear inyección contexto.
    id: 'basic_3',
    tasks: [
      {
        name: 'vision_context_story',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        targetFieldType: 'descriptions',
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 4,
        promptDependentField: null,
      },
      // TODO: intentar mandar visual_accents con 1000px
      {
        // xxxx por foto (xxxx con Batch API aprox.)
        name: 'vision_visual_accents',
        type: 'VisionTask',
        model: 'Molmo',
        sequential: true,
        targetFieldType: 'descriptions',
        prompts: [MESSAGE_ANALYZER_MOLMO_VISUAL_ACCENTS], // no va del todo mal, decirle que no coja elementos distantes o poco visibles
        imagesPerBatch: 4,
        promptsNames: ['visual_accents'],
        promptDependentField: null,
      },
      {
        name: 'tags_context_story',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'tags_visual_accents',
        type: 'TagTask',
        model: 'GPT',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['visual_accents'],
      },
      {
        name: 'chunks_context_story_visual_accents',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        descriptionSourceFields: ['context', 'story', 'visual_accents'],
        descriptionsChunksMethod: {
          context: { type: 'split_by_size', maxLength: 300 },
          story: { type: 'split_by_size', maxLength: 300 },
          visual_accents: { type: 'split_by_size', maxLength: 15 },
        },
      },
    ],
  },
  {
    // con request de 6, 0,002 por foto en low, 1500px (va regu)
    // con request de 4, 0,0038 for foto, high, 1000px
    id: 'topological_upgrade',
    tasks: [
      {
        name: 'topological_tags',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        resolution: 'high',
        targetFieldType: 'tag_area',
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS],
        imagesPerBatch: 4,
        useGuideLines: true,
        promptDependentField: null,
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
      case 'VisualEmbeddingTask':
        task = new VisualEmbeddingTask()
        break
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }
    Object.assign(task, taskData)
    return task
  })
}
