import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { TagTask } from '#models/analyzer/tagTask'
import { VisionDescriptionTask } from '#models/analyzer/visionDescriptionTask'
import { VisionTopologicalTask } from '#models/analyzer/visionTopologicalTask'
import { VisualColorEmbeddingTask } from '#models/analyzer/visualColorEmbeddingTask'
import { VisualDetectionTask } from '#models/analyzer/visualDetectionTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import { MESSAGE_ANALYZER_GPT_CONTEXT_STORY_ACCENTS } from './utils/prompts/descriptions.js'
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
        name: 'clip_embeddings',
        type: 'VisualEmbeddingTask',
        needsImage: true,
        onlyIfNeeded: true,
        checks: ['photo.embedding'],
      },
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
        checks: ['descriptions.context', 'descriptions.story', 'descriptions.visual_accents'],
      },
      {
        name: 'tags_context_story',
        type: 'TagTask',
        model: 'GPT',
        needsImage: false,
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['context', 'story'],
        checks: ['tags.any', 'tags.context_story'],
      },
      {
        name: 'tags_visual_accents',
        type: 'TagTask',
        model: 'GPT',
        needsImage: false,
        prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
        descriptionSourceFields: ['visual_accents'],
        checks: ['tags.visual_accents'],
      },
      {
        name: 'chunks_context_story_visual_accents',
        type: 'ChunkTask',
        prompt: null,
        model: null,
        needsImage: false,
        descriptionSourceFields: ['context', 'story', 'visual_accents'],
        descriptionsChunksMethod: {
          context: { type: 'split_by_size', maxLength: 250 },
          story: { type: 'split_by_size', maxLength: 250 },
          visual_accents: { type: 'split_by_size', maxLength: 15 },
        },
        checks: ['descriptionChunks.any', 'descriptionChunk#*.embedding'],
      },
      {
        name: 'visual_color_embedding_task',
        type: 'VisualColorEmbeddingTask',
        needsImage: true,
        checks: ['photo.color_histogram'],
      },
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
        checks: ['tags.topological'],
      },
    ],
  },

  // {
  //   name: 'visual_detections_task',
  //   type: 'VisualDetectionTask',
  //   needsImage: true,
  //   categories: [
  //     {
  //       name: 'person',
  //       min_box_size: 80,
  //       max_box_area_ratio: 1,
  //       color: 'red',
  //     },
  //     {
  //       name: 'animal',
  //       min_box_size: 90,
  //       max_box_area_ratio: 0.8,
  //       color: 'yellow',
  //     },
  //     {
  //       name: 'prominent object',
  //       min_box_size: 100,
  //       max_box_area_ratio: 0.8,
  //       color: 'green',
  //     },
  //     {
  //       name: 'architectural feature',
  //       min_box_size: 100,
  //       max_box_area_ratio: 0.8,
  //       color: 'orange',
  //     },
  //   ],
  // },
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
      case 'VisualColorEmbeddingTask':
        task = new VisualColorEmbeddingTask(process)
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
