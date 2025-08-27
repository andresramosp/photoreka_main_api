import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { MetadataTask } from '#models/analyzer/metadataTask'
import { TagTask } from '#models/analyzer/tagTask'
import { VisionDescriptionTask } from '#models/analyzer/visionDescriptionTask'
import { VisionTopologicalTask } from '#models/analyzer/visionTopologicalTask'
import { VisualColorEmbeddingTask } from '#models/analyzer/visualColorEmbeddingTask'
import { VisualDetectionTask } from '#models/analyzer/visualDetectionTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import { GlobalEmbeddingsTagsTask } from '#models/analyzer/globalEmbeddingsTagsTask'
import {
  MESSAGE_ANALYZER_GEMINI_CONTEXT_ARTISTIC_SCORES,
  MESSAGE_ANALYZER_GEMINI_CONTEXT_STORY_ACCENTS,
} from './utils/prompts/descriptions.js'
import {
  MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS,
  MESSAGE_TAGS_TEXT_EXTRACTION,
} from './utils/prompts/tags.js'
import { MESSAGE_ANALYZER_VISUAL_ASPECTS } from './utils/prompts/visual_aspects.js'

/**
 * ESTRUCTURA DE PACKAGES CON STAGES
 *
 * Cada package define etapas (stages) que se ejecutan secuencialmente.
 * Dentro de cada stage, las tareas pueden ejecutarse en paralelo o secuencialmente.
 *
 * Estructura:
 * - stages: array de etapas que se ejecutan en orden
 *   - type: 'parallel' | 'sequential' - define cómo se ejecutan las tareas del stage
 *   - tasks: array de tareas o stages anidados
 *
 * Ventajas:
 * - Flexibilidad total para mezclar ejecución paralela y secuencial
 * - Estructura uniforme y clara
 * - Permite anidamiento de stages para casos complejos
 * - Fácil mantenimiento y extensión
 *
 * FUNCIONES CENTRALIZADAS:
 * - extractAllTasks(packageId): Extrae todas las tareas de forma plana (útil para health checking, etc.)
 * - getTaskList(packageId, process): Convierte stages a estructura para el runner (AnalyzerTask | AnalyzerTask[])[]
 */

export const packages = [
  {
    // Context + Story + Accents en una sola llamada GPT
    id: 'preprocess',
    isPreprocess: true, // Indica que este package es de pre-análisis
    stages: [
      {
        type: 'parallel',
        tasks: [
          {
            name: 'metadata_extraction',
            type: 'MetadataTask',
            needsImage: false,
            onlyIfNeeded: true,
            checks: ['descriptions.visual_aspects.orientation'],
          },
          {
            name: 'clip_embeddings',
            type: 'VisualEmbeddingTask',
            needsImage: true,
            onlyIfNeeded: true,
            checks: ['photo.embedding'],
          },
          {
            name: 'visual_color_embedding_task',
            type: 'VisualColorEmbeddingTask',
            needsImage: true,
            checks: ['photo.color_histogram'],
          },
        ],
      },
    ],
  },

  {
    id: 'process',
    isPreprocess: false,
    stages: [
      // Etapa 1: embeddings básicos en paralelo
      {
        type: 'parallel',
        tasks: [
          {
            name: 'visual_color_embedding_task',
            type: 'VisualColorEmbeddingTask',
            needsImage: true,
            onlyIfNeeded: true,
            checks: ['photo.color_histogram'],
          },
          {
            name: 'clip_embeddings',
            type: 'VisualEmbeddingTask',
            needsImage: true,
            onlyIfNeeded: true,
            checks: ['photo.embedding'],
          },
          {
            name: 'metadata_extraction',
            type: 'MetadataTask',
            needsImage: false,
            onlyIfNeeded: true,
            checks: [
              'descriptions.visual_aspects.orientation',
              'descriptions.visual_aspects.temperature',
              'descriptions.visual_aspects.palette',
            ],
          },
        ],
      },
      // Etapa 2 y 3: análisis visual secuencial EN PARALELO con análisis artístico
      {
        type: 'parallel',
        tasks: [
          // Sub-etapa secuencial: análisis visual
          {
            type: 'sequential',
            tasks: [
              {
                // 0.3 EUR / 1000 fotos (gemini-2.5-flash, 4 imágenes por batch, low res)
                // TODO: batchAPI: true,
                name: 'vision_visual_aspects',
                type: 'VisionDescriptionTask',
                model: 'Gemini',
                modelName: 'gemini-2.5-flash',
                needsImage: true,
                sequential: false,
                prompts: [MESSAGE_ANALYZER_VISUAL_ASPECTS],
                resolution: 'low',
                imagesPerBatch: 4,
                promptDependentField: null,
                checks: ['descriptions.visual_aspects.genre'],
                visualAspects: true,
              },
              {
                name: 'tags_visual_aspects',
                type: 'TagTask',
                model: 'Gemini',
                modelName: 'gemini-2.5-flash-lite',
                needsImage: false,
                prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
                descriptionSourceFields: ['visual_aspects'],
                checks: ['tags.any', 'tags.visual_aspects'],
              },
              {
                name: 'vision_context_story_accents',
                type: 'VisionDescriptionTask',
                model: 'Gemini',
                modelName: 'gemini-2.5-flash-lite',
                needsImage: true,
                sequential: false,
                prompts: [MESSAGE_ANALYZER_GEMINI_CONTEXT_STORY_ACCENTS],
                resolution: 'high',
                imagesPerBatch: 1,
                promptDependentField: null,
                checks: [
                  'descriptions.context',
                  'descriptions.story',
                  'descriptions.visual_accents',
                ],
              },
              {
                name: 'tags_context_story',
                type: 'TagTask',
                model: 'Gemini',
                modelName: 'gemini-2.0-flash',
                needsImage: false,
                prompt: MESSAGE_TAGS_TEXT_EXTRACTION,
                descriptionSourceFields: ['context', 'story'],
                checks: ['tags.any', 'tags.context_story'],
              },
              {
                name: 'tags_visual_accents',
                type: 'TagTask',
                model: 'Gemini',
                modelName: 'gemini-2.0-flash',
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
                name: 'topological_tags',
                type: 'VisionTopologicalTask',
                model: 'Gemini',
                modelName: 'gemini-2.0-flash',
                needsImage: true,
                sequential: false,
                resolution: 'low',
                prompts: [MESSAGE_ANALYZER_GPT_TOPOLOGIC_TAGS],
                imagesPerBatch: 1,
                useGuideLines: false,
                promptDependentField: null,
                checks: ['tags.topological'],
              },
            ],
          },
          // Sub-etapa paralela: análisis artístico
          {
            // 1,38 EUR / 1000 fotos (reasoning effort: low)
            // 0.86 EUR / 1000 fotos (reasoning effort: minimal)
            type: 'sequential',
            tasks: [
              {
                name: 'vision_artistic',
                type: 'VisionDescriptionTask',
                model: 'GPT',
                modelName: 'gpt-5',
                needsImage: true,
                sequential: false,
                prompts: [MESSAGE_ANALYZER_GEMINI_CONTEXT_ARTISTIC_SCORES],
                resolution: 'high',
                imagesPerBatch: 6,
                batchAPI: true,
                promptDependentField: null,
                checks: ['descriptions.artistic_scores'],
              },
            ],
          },
        ],
      },
    ],
  },

  // ...existing code...
  {
    id: 'remake_visuals',
    isPreprocess: false,
    stages: [
      {
        type: 'parallel',
        tasks: [
          {
            name: 'vision_visual_aspects',
            type: 'VisionDescriptionTask',
            model: 'Gemini',
            modelName: 'gemini-2.5-flash-lite',
            needsImage: true,
            sequential: false,
            prompts: [MESSAGE_ANALYZER_VISUAL_ASPECTS],
            resolution: 'low',
            imagesPerBatch: 8,
            promptDependentField: null,
            checks: ['descriptions.visual_aspects.genre'],
            visualAspects: true,
          },
          {
            name: 'vision_artistic',
            type: 'VisionDescriptionTask',
            model: 'GPT',
            modelName: 'gpt-5', //'gpt-5-chat-latest',
            needsImage: true,
            sequential: false,
            prompts: [MESSAGE_ANALYZER_GEMINI_CONTEXT_ARTISTIC_SCORES],
            resolution: 'high',
            imagesPerBatch: 6,
            batchAPI: true,
            promptDependentField: null,
            checks: ['descriptions.artistic_scores'],
          },
        ],
      },
    ],
  },
  // PAYLOAD:
  // {
  //     "userId": "1234",
  //     "packageId": "global_embeddings",
  //     "mode": "global",
  //     "isGlobal": true
  // }
  {
    id: 'global_embeddings',
    isPreprocess: false,
    stages: [
      {
        type: 'sequential',
        tasks: [
          {
            name: 'review_embeddings_tags',
            type: 'GlobalEmbeddingsTagsTask',
            isGlobal: true,
          },
        ],
      },
    ],
  },
]

/**
 * Extrae todas las tareas de manera plana desde la estructura de stages
 * Útil para operaciones que necesiten acceso a todas las tareas individuales
 */
export const extractAllTasks = (packageId: string): any[] => {
  const pkg = packages.find((p) => p.id === packageId)
  if (!pkg || !('stages' in pkg) || !pkg.stages) {
    return []
  }

  const extractFromStages = (stages: any[]): any[] => {
    const allTasks: any[] = []

    for (const stage of stages) {
      if (stage.tasks) {
        for (const taskOrStage of stage.tasks) {
          if (taskOrStage.name && taskOrStage.type) {
            // Es una tarea individual
            allTasks.push(taskOrStage)
          } else if (taskOrStage.type && taskOrStage.tasks) {
            // Es un stage anidado, extraer recursivamente
            allTasks.push(...extractFromStages([taskOrStage]))
          }
        }
      }
    }

    return allTasks
  }

  return extractFromStages(pkg.stages)
}

/**
 * Convierte la estructura de stages a la estructura esperada por el runner
 * (AnalyzerTask | AnalyzerTask[])[] donde arrays = tareas paralelas
 */
export const getTaskList = (
  packageId: string,
  process: AnalyzerProcess
): (AnalyzerTask | AnalyzerTask[])[] => {
  const pkg = packages.find((p) => p.id === packageId)
  if (!pkg) {
    throw new Error(`Package with id ${packageId} not found`)
  }

  // Asignar la propiedad isPreprocess al proceso
  process.isPreprocess = pkg.isPreprocess || false

  // Función auxiliar para crear una tarea desde su configuración
  const createTask = (taskData: any): AnalyzerTask => {
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
      case 'MetadataTask':
        task = new MetadataTask(process)
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
      case 'GlobalEmbeddingsTagsTask':
        task = new GlobalEmbeddingsTagsTask(process)
        break
      default:
        throw new Error(`Unknown task type: ${taskData.type}`)
    }
    Object.assign(task, taskData)
    return task
  }

  // Función auxiliar para procesar un stage y convertirlo a la estructura esperada
  const processStage = (stage: any): (AnalyzerTask | AnalyzerTask[])[] => {
    if (stage.type === 'parallel') {
      // Para stages paralelos, todas las tareas van en un solo array
      const parallelTasks: AnalyzerTask[] = []

      for (const taskOrStage of stage.tasks) {
        if (taskOrStage.name && taskOrStage.type) {
          // Es una tarea individual
          parallelTasks.push(createTask(taskOrStage))
        } else if (taskOrStage.type && taskOrStage.tasks) {
          // Es un stage anidado - procesar y agregar sus resultados
          const nestedResults = processStage(taskOrStage)
          for (const nestedResult of nestedResults) {
            if (Array.isArray(nestedResult)) {
              parallelTasks.push(...nestedResult)
            } else {
              parallelTasks.push(nestedResult)
            }
          }
        }
      }

      return parallelTasks.length > 0 ? [parallelTasks] : []
    } else if (stage.type === 'sequential') {
      // Para stages secuenciales, cada tarea/grupo va por separado
      const result: (AnalyzerTask | AnalyzerTask[])[] = []

      for (const taskOrStage of stage.tasks) {
        if (taskOrStage.name && taskOrStage.type) {
          // Es una tarea individual
          result.push(createTask(taskOrStage))
        } else if (taskOrStage.type && taskOrStage.tasks) {
          // Es un stage anidado
          const nestedResults = processStage(taskOrStage)
          result.push(...nestedResults)
        }
      }

      return result
    }

    return []
  }

  // Procesar todos los stages
  const allResults: (AnalyzerTask | AnalyzerTask[])[] = []

  if ('stages' in pkg && pkg.stages) {
    for (const stage of pkg.stages) {
      const stageResults = processStage(stage)
      allResults.push(...stageResults)
    }
  }

  return allResults
}
