import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { TagTask } from '#models/analyzer/tagTask'
import { VisionTask } from '#models/analyzer/visionTask'
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
    // 0,0082 por foto (0,0061 con Batch API aprox.)
    id: 'basic',
    tasks: [
      {
        // xxxx por foto (xxxx con Batch API aprox.)
        name: 'vision_context_story',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        targetFieldType: 'descriptions',
        prompts: [MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY],
        resolution: 'high',
        imagesPerBatch: 5,
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
          context: 'split_by_size',
          story: 'split_by_size',
          visual_accents: 'split_by_pipes',
        },
      },
    ],
  },

  {
    // 0,002 por foto
    id: 'topological_upgrade',
    tasks: [
      {
        name: 'topological_tags',
        type: 'VisionTask',
        model: 'GPT',
        sequential: false,
        resolution: 'low',
        targetFieldType: 'tag_area',
        prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS],
        imagesPerBatch: 6,
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
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }
    Object.assign(task, taskData)
    return task
  })
}
