import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { TagTask } from '#models/analyzer/tagTask'
import { VisionDescriptionTask } from '#models/analyzer/visionDescriptionTask'
import { VisionTopologicalTask } from '#models/analyzer/visionTopologicalTask'
import { VisualDetectionTask } from '#models/analyzer/visualDetectionTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import {
  MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS,
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
      {
        name: 'vision_context_story_accents',
        type: 'VisionDescriptionTask',
        model: 'GPT',
        needsImage: true,
        sequential: false,
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS],
        resolution: 'high',
        imagesPerBatch: 4,
        promptDependentField: null,
      },
      {
        name: 'tags_context_story',
        type: 'TagTask',
        model: 'GPT',
        needsImage: false,
        dependsOn: 'vision_context_story_accents',
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['context', 'story'],
      },
      {
        name: 'tags_visual_accents',
        type: 'TagTask',
        model: 'GPT',
        dependsOn: 'vision_context_story_accents',
        needsImage: false,
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['visual_accents'],
      },
      {
        name: 'chunks_context_story_visual_accents',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        needsImage: false,
        dependsOn: 'vision_context_story_accents',
        descriptionSourceFields: ['context', 'story', 'visual_accents'],
        descriptionsChunksMethod: {
          context: { type: 'split_by_size', maxLength: 250 },
          story: { type: 'split_by_size', maxLength: 250 },
          visual_accents: { type: 'split_by_size', maxLength: 15 },
        },
      },
      {
        name: 'visual_embedding_task',
        type: 'VisualEmbeddingTask',
        needsImage: true,
      },
      {
        name: 'visual_detections_task',
        type: 'VisualDetectionTask',
        needsImage: true,
        categories: [
          {
            name: 'person',
            min_box_size: 80,
            max_box_area_ratio: 1,
            color: 'red',
          },
          {
            name: 'animal',
            min_box_size: 90,
            max_box_area_ratio: 0.8,
            color: 'yellow',
          },
          {
            name: 'prominent object',
            min_box_size: 100,
            max_box_area_ratio: 0.8,
            color: 'green',
          },
          {
            name: 'architectural feature',
            min_box_size: 100,
            max_box_area_ratio: 0.8,
            color: 'orange',
          },
        ],
      },
    ],
  },
  {
    id: 'topological_upgrade',
    tasks: [
      {
        name: 'topological_tags',
        type: 'VisionTopologicalTask',
        model: 'GPT',
        needsImage: true,
        sequential: false,
        resolution: 'high',
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS],
        imagesPerBatch: 4,
        useGuideLines: true,
        promptDependentField: null,
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
        type: 'VisionDescriptionTask',
        model: 'GPT',
        sequential: false,
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 4,
        promptDependentField: null,
      },
      // TODO: intentar mandar visual_accents con 1000px
      {
        // xxxx por foto (xxxx con Batch API aprox.)
        name: 'vision_visual_accents',
        type: 'VisionDescriptionTask',
        model: 'Molmo',
        sequential: true,
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
]

export const getTaskList = (packageId: string, process: AnalyzerProcess): AnalyzerTask[] => {
  const pkg = packages.find((p) => p.id === packageId)
  if (!pkg) {
    throw new Error(`Package with id ${packageId} not found`)
  }
  return pkg.tasks.map((taskData) => {
    let task: AnalyzerTask
    switch (taskData.type) {
      case 'VisionDescriptionTask':
        task = new VisionDescriptionTask(process)
        break
      case 'VisionTopologicalTask':
        task = new VisionTopologicalTask(process)
        break
      case 'TagTask':
        task = new TagTask(process)
        break
      case 'ChunkTask':
        task = new ChunkTask(process)
        break
      case 'VisualEmbeddingTask':
        task = new VisualEmbeddingTask(process)
        break
      case 'VisualDetectionTask':
        task = new VisualDetectionTask(process)
        break
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }
    Object.assign(task, taskData)
    return task
  })
}
