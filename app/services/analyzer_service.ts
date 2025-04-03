// @ts-nocheck

import AnalyzerProcess, { AnalyzerMode, StageType } from '#models/analyzer/analyzerProcess'
import ModelsService from './models_service.js'
import Photo, { DescriptionType } from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import Tag from '#models/tag'
import DescriptionChunk from '#models/descriptionChunk'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { getTaskList } from '../analyzer_packages.js'
import ws from './ws.js'
import PhotoImage from '#models/analyzer/photoImage'
import { parseJSONSafe } from '../utils/jsonUtils.js'
import { VisionTask } from '#models/analyzer/visionTask'
import { TagTask } from '#models/analyzer/tagTask'
import { ChunkTask } from '#models/analyzer/chunkTask'
import { AnalyzerTask } from '#models/analyzer/analyzerTask'
import { VisualEmbeddingTask } from '#models/analyzer/visualEmbeddingTask'
import { base64 } from '@adonisjs/core/helpers'
import { VisualDetectionTask } from '#models/analyzer/VisualDetectionTask'

export default class AnalyzerProcessRunner {
  private process: AnalyzerProcess
  private modelsService: ModelsService

  constructor() {
    this.process = new AnalyzerProcess()
    this.modelsService = new ModelsService()
  }

  public async initProcess(
    userPhotos: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'first',
    processId: number
  ) {
    let tasks
    if (mode == 'retry') {
      this.process = await AnalyzerProcess.query()
        .where('id', processId)
        .preload('photos')
        .firstOrFail()
      tasks = getTaskList(this.process?.packageId)
    }
    this.process.mode = mode
    const photosToProcess = this.getInitialPhotos(userPhotos)

    tasks = getTaskList(packageId)
    this.process.currentStage = 'init' // TODO: esto puede variar en 'retry'
    this.process.packageId = packageId
    this.process.tasks = tasks
    await this.process.save()
    await this.setProcessPhotos(photosToProcess)
    await this.process.populatePhotoImages()
    await this.changeStage(
      `Process Started | Package: ${packageId} | ${photosToProcess.length} photos`,
      'vision_tasks'
    )
  }

  public getInitialPhotos(userPhotos: Photo[]) {
    if (this.process.mode == 'adding') {
      return userPhotos.filter((photo: Photo) => !photo.analyzerProcess)
    } else if (this.process.mode == 'first' || this.process.mode == 'remake') {
      return userPhotos
    } else {
      // En retry no hay fotos iniciales, la primera stage cogerá sus fallidas
      return []
    }
  }

  public async *run() {
    if (!this.process || !this.process.tasks) {
      throw new Exception('[ERROR] No process found')
    }

    const visionTasks = this.process.tasks.filter((task) => task instanceof VisionTask)
    for (const task of visionTasks) {
      await this.changeStage(`Vision Task initiating: ${task.name}`, 'vision_tasks')
      await this.executeVisionTask(task, task.sequential)
      await this.changeStage(`Vision task complete: ${task.name}`)
    }

    const tagsTasks = this.process.tasks.filter((task) => task instanceof TagTask)
    for (const task of tagsTasks) {
      await this.changeStage(`Tag Task initiating: ${task.name}`, 'tags_tasks')
      await this.executeTagsTask(task)
      await this.changeStage(`Tags task complete: ${task.name}`)
    }

    if (tagsTasks.length) {
      await this.changeStage('Tags Embeddings initiating', 'embeddings_tags')
      await this.createTagsEmbeddings()
      await this.changeStage('Tags Embeddings complete')
    }

    const chunkTasks = this.process.tasks.filter((task) => task instanceof ChunkTask)
    for (const task of chunkTasks) {
      await this.changeStage(`Chunks Task initiating: ${task.name}`, 'chunks_tasks')
      await this.executeChunksTask(task)
      await task.commit()
      await this.changeStage(`Chunk task complete: ${task.name}`)
    }

    if (chunkTasks.length) {
      await this.changeStage('Chunks Embeddings initiating', 'embeddings_chunks')
      await this.createChunksEmbeddings()
      await this.changeStage('Chunks Embeddings complete')
    }

    const visualEmbeddingTask = this.process.tasks.find(
      (task) => task instanceof VisualEmbeddingTask
    )
    if (visualEmbeddingTask) {
      await this.executeVisualEmbeddingTask(visualEmbeddingTask)
    }

    const visualDetectionTask = this.process.tasks.find(
      (task) => task instanceof VisualDetectionTask
    )
    if (visualDetectionTask) {
      await this.executeVisualDetectionTask(visualDetectionTask)
    }

    await this.changeStage('Process Completed', 'finished')

    yield { type: 'analysisComplete', data: { costs: [] } }
  }

  // @MeasureExecutionTime
  private async executeVisionTask(task: VisionTask, sequential: boolean) {
    if (!task.data) {
      task.data = {}
    }

    // 1. Obtenemos el listado completo de imágenes a procesar
    const pendingPhotoImages: PhotoImage[] = await this.getPendingPhotosForTask(task)

    // 2. Agrupamos las imágenes en lotes ("batches")
    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotoImages.length; i += task.imagesPerBatch) {
      const batch = pendingPhotoImages.slice(i, i + task.imagesPerBatch)
      batches.push(batch)
    }

    // Función que procesa cada batch
    const processBatch = async (batch: PhotoImage[], idx: number) => {
      // Retraso incremental según el índice de batch
      await this.sleep(idx * 1500)

      let response: any
      const injectedPrompts: any = await this.injectPromptsDpendencies(task, batch)
      console.log(
        `[AnalyzerProcess]: Vision Task calling ${task.model} for ${batch.length} images...`
      )

      try {
        response = await this[`execute${task.model}Task`](injectedPrompts, batch, task)
        if (this.process.mode == 'retry') {
          this.process.removeFailed(
            batch.map((b) => b.photo.id),
            task.name
          )
        }
      } catch (err) {
        console.log(`[AnalyzerProcess]: Error en ${task.model} for ${batch.length} images...`)
        this.process.addFailed(
          batch.map((b) => b.photo.id),
          task.name
        )
        return
      }

      // Guardamos resultados en task.data
      response.result.forEach((res, photoIndex) => {
        const { ...results } = res
        const photoId = batch[photoIndex].photo.id
        // if (photoId == 129) {
        //   console.log()
        // }
        task.data[photoId] = { ...task.data[photoId], ...results }
      })

      // Confirmamos estado del task
      await task.commit()
      console.log(`[AnalyzerProcess]: Committed ${task.model} for ${batch.length} images...`)
    }

    // Ejecutamos de forma secuencial o concurrente según el parámetro
    if (sequential) {
      for (let i = 0; i < batches.length; i++) {
        await processBatch(batches[i], i)
      }
    } else {
      await Promise.all(batches.map((batch, idx) => processBatch(batch, idx)))
    }
  }

  // @MeasureExecutionTime
  private async executeTagsTask(task: TagTask) {
    console.log(
      '[AnalyzerProcess]: TagTask: Iniciando fase 1 - Carga y limpieza de descripciones...'
    )

    if (!task.data) {
      task.data = {}
    }

    const pendingPhotos = await this.getPendingPhotosForTask(task)

    const cleanedResults = await this.cleanPhotosDescs(pendingPhotos, task)

    console.log('[AnalyzerProcess]: TagTask: Procesando extracción de tags...')

    await this.requestTagsFromGPT(pendingPhotos, task, cleanedResults)

    console.log('[AnalyzerProcess]: TagTask: Filtrando y guardando en DB...')

    await task.commit()

    console.log('[AnalyzerProcess]: TagTask: Finalizado.')
  }

  private async requestTagsFromGPT(photos: Photo[], task: TagTask, cleanedResults: string[]) {
    const tagRequests: Promise<void>[] = []
    const totalPhotos = this.process.photos.length
    // Inicia un log sin salto de línea para ir agregando IDs
    process.stdout.write(`[AnalyzerProcess]: TagTask: Realizando requests GPT para `)

    photos.forEach((photo, index) => {
      const requestPromise = (async () => {
        // Espera un retraso distinto para cada foto
        await this.sleep(index * 500)

        try {
          const { result: extractedTagsResponse } = await this.modelsService.getGPTResponse(
            task.prompt as string,
            JSON.stringify({ description: cleanedResults[index] }),
            'gpt-4o-mini'
          )
          const { tags: tagList } = extractedTagsResponse

          // Asegurar "no people" si no hay grupo 'person'
          const hasPerson = tagList.some((t: string) => t.split('|')[1]?.trim() === 'person')
          if (!hasPerson) {
            tagList.push('no people | misc')
          }

          task.data[photo.id] = []

          // TODO: todo esto deberia trabajar con TagPhoto, y usar el validate para ver si hay que crear un nuevo tag en 'tags', o reusar uno.

          tagList.forEach((tagStr: string) => {
            const [tag, group = 'misc'] = tagStr.split('|').map((i) => i.trim())
            const newTag = new Tag()
            newTag.name = tag
            newTag.group = group
            task.data[photo.id].push(newTag)
          })
          if (this.process.mode == 'retry') {
            this.process.removeFailed([photo.id], task.name)
          }
        } catch (err) {
          console.log(`[AnalyzerProcess]: Error en ${task.name} -> ${err}`)
          await this.process.addFailed([photo.id], task.name)
        }

        const progress = Math.floor(((index + 1) / totalPhotos) * 100)
        process.stdout.write(`[${photo.id}] ${progress}% `)
      })()

      tagRequests.push(requestPromise)
    })

    await Promise.all(tagRequests)

    // Salta de línea al completar
    process.stdout.write('\n')
  }

  // TODO: hacerlo más selectivo, para que solo opere sobre las descriptions indicadas, como la tarea de tags
  public async executeChunksTask(task: ChunkTask) {
    if (!task.data) {
      task.data = {}
    }

    for (let photo of this.process.photos) {
      await photo.refresh()
      if (!photo.descriptions || typeof photo.descriptions !== 'object') {
        throw new Error('No descriptions found for this photo')
      }

      for (const category of task.descriptionSourceFields) {
        const description = photo.descriptions[category]
        if (!description) continue

        let descriptionChunks
        let { type: splitMethod, maxLength } = task.descriptionsChunksMethod[category]
          ? task.descriptionsChunksMethod[category]
          : 'split_by_size'
        if (splitMethod === 'split_by_pipes') {
          descriptionChunks = description.split('|').filter((ch: string) => ch.length > 0)
        } else {
          descriptionChunks = this.splitIntoChunks(description, maxLength)
        }

        await DescriptionChunk.query()
          .where('photoId', photo.id)
          .where('category', category)
          .delete()

        await Promise.all(
          descriptionChunks.map((chunk) =>
            DescriptionChunk.create({
              photoId: photo.id,
              chunk,
              category,
            })
          )
        )
      }
    }
  }

  private async executeGPTTask(prompts: string[], batch: any[], task: VisionTask): Promise<any> {
    const prompt = prompts[0]
    const images = batch.map((pp) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${pp.base64}`,
        detail: task.resolution,
      },
    }))
    // const response = await this.retryCall(() =>
    //   this.modelsService.getGPTResponse(prompt, images, 'gpt-4o', null, 0)
    // )
    const response = await this.modelsService.getGPTResponse(prompt, images, 'gpt-4o', null, 0)
    return response || { result: [] }
  }

  private async executeMolmoTask(prompts: string[], batch: any[], task: VisionTask): Promise<any> {
    const response = await this.modelsService.getMolmoResponse(
      batch.map((pp) => ({ id: pp.photo.id, base64: pp.base64 })),
      [],
      prompts
    )
    if (!response) return { result: [] }

    const { result } = response
    const homogenizedResult = result.map((photoResult: any) => {
      let descriptionsByPrompt: { [key: string]: any } = {}
      task.promptsNames.forEach((targetPrompt) => {
        try {
          const descObj = photoResult.descriptions.find((d: any) => d.id_prompt === targetPrompt)
          descriptionsByPrompt = descObj.description
          // descriptionsByPrompt = descObj
          //   ? parseJSONSafe(`${descObj.description}`, {
          //       left_area_shows: 'left',
          //       right_area_shows: 'right',
          //       middle_area_shows: 'middle',
          //     })
          //   : null
        } catch (err) {
          console.log(`[AnalyzerProcess]: Error en ${task.model} for ${photoResult.id} images...`)
          this.process.addFailed([photoResult.id], task.name)
        }
      })
      return {
        [task.promptsNames[0]]: descriptionsByPrompt,
      }
    })
    return { result: homogenizedResult }
  }

  // TODO: los tags deben compararse usando también el grupo (orange | fruit, orange | color)

  @MeasureExecutionTime
  public async createTagsEmbeddings() {
    // Recorremos todas las fotos y recogemos los tags sin embedding (sin duplicados)
    const allTagsMap = new Map<string, Tag>()
    for (const photo of this.process.photos) {
      await photo.load('tags')
      for (const tagPhoto of photo.tags) {
        await tagPhoto.load('tag')
        if (!tagPhoto.tag.embedding) {
          const key = tagPhoto.tag.name.toLowerCase()
          if (!allTagsMap.has(key)) {
            allTagsMap.set(key, tagPhoto.tag)
          }
        }
      }
    }
    const tagsToCompute = Array.from(allTagsMap.values())
    // Procesamos en lotes de 16
    for (let i = 0; i < tagsToCompute.length; i += 16) {
      await this.sleep(250)
      const batch = tagsToCompute.slice(i, i + 16)
      const tagNames = batch.map((tag) => tag.name)
      const { embeddings } = await this.modelsService.getEmbeddings(tagNames)
      await Promise.all(
        batch.map((tag, index) => {
          tag.embedding = embeddings[index]
          return tag.save()
        })
      )
    }
  }

  @MeasureExecutionTime
  public async createChunksEmbeddings() {
    const chunks = await DescriptionChunk.query().whereNull('embedding')

    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16)
      const texts = batch.map((chunk) => chunk.chunk)
      // console.log(`[AnalyzerProcess]: Creando chunks para ${texts.join(' | ')}`)
      const { embeddings } = await this.modelsService.getEmbeddings(texts)
      await Promise.all(
        batch.map((chunk, index) => {
          chunk.embedding = embeddings[index]
          return chunk.save()
        })
      )
    }
  }

  @MeasureExecutionTime
  private async executeVisualEmbeddingTask(task: VisualEmbeddingTask) {
    if (!task.data) {
      task.data = {}
    }

    let photosToProcess: PhotoImage[] = this.process.photoImages
    for (let i = 0; i < photosToProcess.length; i += 16) {
      await this.sleep(250)
      const batch = photosToProcess.slice(i, i + 16)
      const payload = batch.map((pi: PhotoImage) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { embeddings } = await this.modelsService.getEmbeddingsImages(payload)
      await Promise.all(
        batch.map((pi: PhotoImage, index) => {
          const photo: Photo = pi.photo
          photo.embedding = embeddings.find((item) => item.id == pi.photo.id).embedding
          return photo.save()
        })
      )
    }
  }

  private async executeVisualDetectionTask(task: VisualDetectionTask) {
    if (!task.data) {
      task.data = {}
    }
    const batchSize = 10
    let photosToProcess: PhotoImage[] = this.process.photoImages
    for (let i = 0; i < photosToProcess.length; i += batchSize) {
      await this.sleep(250)
      const batch = photosToProcess.slice(i, i + batchSize)
      const payload = batch.map((pi: PhotoImage) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { detections: result } = await this.modelsService.getObjectsDetections(
        payload,
        task.categories,
        task.minBoxSize
      )
      result.forEach((res, photoIndex) => {
        const { id: photoId, detections } = res
        task.data[photoId] = { ...detections }
      })

      await task.commit()
      console.log(`[AnalyzerProcess]: Committed ${task.name} for ${batch.length} images...`)
    }
  }

  // FUNCIONES AUXILIARES //

  private async changeStage(message: string, nextStage: StageType = null) {
    ws.io?.emit('stageChanged', { message })
    if (nextStage) {
      this.process.currentStage = nextStage
      await this.process.save()
    }
    console.log(`[AnalyzerProcess]: ${message}`)
  }

  private async injectPromptsDpendencies(task: VisionTask, batch: PhotoImage[]): Promise<any> {
    let result = task.prompts

    if (task.promptDependentField || task.model == 'Molmo') {
      const promptList = task.promptsNames.map((target: DescriptionType, index: number) => ({
        id: target,
        prompt: task.prompts[index],
      }))

      result = await Promise.all(
        batch.map(async (photoImage: PhotoImage) => {
          await photoImage.photo.refresh()
          return {
            id: photoImage.photo.id,
            prompts: promptList.map((p) => ({
              id: p.id,
              text: p.prompt(), //p.prompt(photoImage.photo.descriptions[task.promptDependentField]),
            })),
          }
        })
      )
    } else {
      result = task.prompts.map((p) => p(batch.map((b) => b.photo))) // Inyección de fotos por defecto
    }

    return result
  }

  // Dada una tarea obtiene las fotos que quedan en el "embudo" del pipeline y añada sus propias fallidas si las hay
  private async getPendingPhotosForTask(task: AnalyzerTask): Promise<PhotoImage[] | Photo[]> {
    await this.process.load('photos')
    // Cogemos las fotos actualmente en el pipeline (las fallidas de fases previas se habrán borrado)
    let pendingPhotosPipelineIds: string[] = this.process.photos.map((p) => p.id)
    let currentTaskIndex = this.process.tasks?.findIndex((t) => t.name == task.name)
    let previousTaskNames = this.process.tasks?.slice(0, currentTaskIndex).map((t) => t.name)
    let failedInPreviousStagesIds: string[] = this.process.failed
      ? Object.keys(this.process.failed).filter((nameId) => previousTaskNames.includes(nameId))
      : []
    pendingPhotosPipelineIds = pendingPhotosPipelineIds.filter(
      (id) => !failedInPreviousStagesIds.includes(id)
    )

    // Si retry, añadimos las fallidas de esta fase
    if (this.process.mode == 'retry') {
      const failedPhotosForStageIds = Object.keys(this.process.failed).filter(
        (id) => this.process.failed[id] == task.name
      )
      pendingPhotosPipelineIds = pendingPhotosPipelineIds.concat(failedPhotosForStageIds)
    }

    if (task instanceof VisionTask) {
      const field = task.useGuideLines ? 'photoImagesWithGuides' : 'photoImages'
      return this.process[field].filter((pi: PhotoImage) =>
        pendingPhotosPipelineIds.includes(pi.photo.id)
      )
    } else {
      return this.process.photos.filter((p: Photo) => pendingPhotosPipelineIds.includes(p.id))
    }
  }

  private splitIntoChunks(desc: string, maxLength: number = 300): string[] {
    const sentences = desc.split(/(?<=[.!?])\s+/)
    const chunks: string[] = []
    let currentChunk = ''

    for (const sentence of sentences) {
      const withSentence = currentChunk ? currentChunk + ' ' + sentence : sentence

      if (withSentence.length <= maxLength) {
        currentChunk = withSentence
      } else {
        if (currentChunk) chunks.push(currentChunk)
        currentChunk = sentence // empieza nuevo chunk incluso si ya pasa de maxLength
      }
    }

    if (currentChunk) chunks.push(currentChunk)

    return chunks
  }

  private async cleanPhotosDescs(photos: Photo[], task: TagTask, batchSize = 5, delayMs = 500) {
    const results = []

    for (let i = 0; i < photos.length; i += batchSize) {
      const batch = photos.slice(i, i + batchSize)

      const [cleanResult] = await Promise.all([
        this.modelsService.cleanDescriptions(
          batch.map((photo) => {
            return this.getSourceTextFromPhoto(task, photo)
          }),
          0.9
        ),
      ])

      results.push(...cleanResult)

      if (i + batchSize < photos.length) {
        await this.sleep(delayMs)
      }
    }

    return results
  }

  public getSourceTextFromPhoto(task: TagTask, photo: Photo) {
    let text = ''

    for (const category of task.descriptionSourceFields) {
      const description = photo.descriptions?.[category]

      let flattenedDescription: string

      if (typeof description === 'object' && description !== null) {
        // Si es un objeto (ya es JSON), concatenamos sus valores
        // flattenedDescription = Object.values(description)
        //   .filter((value) => value) // Filtramos valores vacíos o nulos
        //   .join(' ') // Espacio en lugar de '|'

        flattenedDescription = JSON.stringify(description)
      } else {
        // Si no es un objeto, lo tratamos como string normal
        flattenedDescription = description ?? ''
      }

      text += `${category}: ${flattenedDescription} | ` // Pipe solo entre categorías
    }

    return text.trim().replace(/\|$/, '') // Eliminamos el pipe final si sobra
  }

  // Función auxiliar para reintentos (hasta 3 intentos con 5 segundos de espera)
  private async retryCall<T>(fn: () => Promise<T>): Promise<T | null> {
    let attempts = 0
    while (attempts < 3) {
      try {
        return await fn()
      } catch (error) {
        attempts++
        console.error(`[AnalyzerTask]: Re-intento ${attempts} fallido: ${error}`)
        if (attempts < 3) await this.sleep(5000)
      }
    }
    return null
  }

  private async setProcessPhotos(photos: Photo[]) {
    const newPhotosIds = photos.map((p) => p.id)
    await Photo.query()
      .where('analyzer_process_id', this.process.id)
      .whereNotIn('id', newPhotosIds)
      .update({ analyzer_process_id: null })

    // Asocia las nuevas fotos al proceso
    await Photo.query().whereIn('id', newPhotosIds).update({ analyzer_process_id: this.process.id })
    await this.process.load('photos', (query) =>
      query.preload('tags', (query) => query.preload('tag'))
    )
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
