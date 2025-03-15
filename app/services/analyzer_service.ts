// @ts-nocheck

import AnalyzerProcess, { StageType } from '#models/analyzer/analyzerProcess'
import EmbeddingsService from './embeddings_service.js'
import ModelsService from './models_service.js'
import NLPService from './nlp_service.js'
import Photo, { DescriptionType } from '#models/photo'
import { AnalyzerTask, VisionTask, TagTask, ChunkTask } from '#models/analyzer/analyzerTask'
import { Exception } from '@adonisjs/core/exceptions'
import Tag from '#models/tag'
import { STOPWORDS } from '../utils/StopWords.js'
import DescriptionChunk from '#models/descriptionChunk'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { getTaskList } from '../analyzer_packages.js'
import ws from './ws.js'
import PhotoImage from '#models/analyzer/photoImage'
import db from '@adonisjs/lucid/services/db'

export default class AnalyzerProcessRunner {
  private process: AnalyzerProcess
  private modelsService: ModelsService
  private nlpService: NLPService
  private embeddingsService: EmbeddingsService

  constructor() {
    this.process = new AnalyzerProcess()
    this.modelsService = new ModelsService()
    this.nlpService = new NLPService()
    this.embeddingsService = new EmbeddingsService()
  }

  public async initProcess(
    userPhotos: Photo[],
    packageId: string,
    isUpgradeOrRemake: boolean = false
  ) {
    const unproccesedPhotos = isUpgradeOrRemake
      ? userPhotos
      : userPhotos.filter((photo: Photo) => !photo.analyzerProcess) // para fotos añadidas!
    const tasks = getTaskList(packageId)
    this.process.currentStage = 'init'
    this.process.packageId = packageId
    this.process.tasks = tasks
    await this.process.save()
    await this.process.related('photos').updateOrCreateMany(unproccesedPhotos)
    await this.process.load('photos')
    await this.process.populatePhotoImages()
    await this.changeStage(
      `Process Started | Package: ${packageId} | ${unproccesedPhotos.length} photos`,
      'vision_tasks'
    )
  }

  public async resumeProcess(userPhotos: Photo[], processId: number) {
    this.process = await AnalyzerProcess.query()
      .where('id', processId)
      .preload('photos')
      .firstOrFail()
    const tasks = getTaskList(this.process?.packageId)
    this.process.currentStage = 'init' // TODO: deberiamos poder saltar a la primera stage de currentStage
    this.process.tasks = tasks
    await this.process.save()
    await this.process.populatePhotoImages()
    await this.changeStage(
      `Process Resumed | ID: ${processId} | ${this.process.photos.length} photos`
    )
  }

  public async *run() {
    if (!this.process || !this.process.tasks) {
      throw new Exception('[ERROR] No process found')
    }

    const visionTasks = this.process.tasks.filter((task) => task instanceof VisionTask)
    for (const task of visionTasks) {
      await this.changeStage(`Initiating vision task: ${task.name}`, 'vision_tasks')
      await this.executeVisionTask(task, task.sequential)
      await this.changeStage(`Vision task complete: ${task.name}`)
    }

    const tagsTasks = this.process.tasks.filter((task) => task instanceof TagTask)
    for (const task of tagsTasks) {
      await this.changeStage(`Initiating tags task: ${task.name}`, 'tags_tasks')
      await this.executeTagsTask(task)
      await this.changeStage(`Tags task complete: ${task.name}`)
    }

    if (tagsTasks.length) {
      await this.changeStage('Initiating tags embeddings task', 'embeddings_tags')
      await this.createTagsEmbeddings()
      await this.changeStage('Tags Embeddings complete')
    }

    const chunkTasks = this.process.tasks.filter((task) => task instanceof ChunkTask)
    for (const task of chunkTasks) {
      await this.changeStage(`Initiating chunks task: ${task.name}`, 'chunks_tasks')
      await this.executeChunksTask(task)
      await task.commit()
      await this.changeStage(`Chunk task complete: ${task.name}`)
    }

    if (chunkTasks.length) {
      await this.changeStage('Initiating chunks embeddings task', 'embeddings_chunks')
      await this.createChunksEmbeddings()
      await this.changeStage('Chunks Embeddings complete')
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
    const pendingPhotoImages = await this.getPendingPhotosForVisionTask(task)

    // 2. Agrupamos las imágenes en lotes ("batches")
    const batches: any[][] = []
    for (let i = 0; i < pendingPhotoImages.length; i += task.imagesPerBatch) {
      const batch = pendingPhotoImages.slice(i, i + task.imagesPerBatch)
      batches.push(batch)
    }

    // Función que procesa cada batch
    const processBatch = async (batch: any[], idx: number) => {
      // Retraso incremental según el índice de batch
      await this.sleep(idx * 750)

      let response: any
      const injectedPrompts: any = await this.injectPromptsDpendencies(task, batch)
      console.log(
        `[AnalyzerProcess]: Vision Task calling ${task.model} for ${batch.length} images...`
      )

      try {
        response = await this[`execute${task.model}Task`](injectedPrompts, batch, task)
      } catch (err) {
        console.log(`[AnalyzerProcess]: Error en ${task.model} for ${batch.length} images...`)
        return
      }

      // Guardamos descripciones en task.data
      for (const res of response.result) {
        const { id, ...descriptions } = res
        task.data[id] = { ...task.data[id], ...descriptions }
      }

      // Confirmamos estado del task
      await task.commit()
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

    const pendingPhotos = await this.getPendingPhotosForTagsTask(task)

    const cleanedResults = await this.cleanPhotosDescs(pendingPhotos, task.descriptionSourceFields)

    console.log('[AnalyzerProcess]: TagTask: Fase 2 - Procesando solicitudes a GPT...')

    await this.requestTagsFromGPT(pendingPhotos, task, cleanedResults)

    console.log('[AnalyzerProcess]: TagTask: Fase 3 - Filtrando y guardando en DB...')

    await this.filterAndSaveTags(pendingPhotos, task)

    console.log('[AnalyzerProcess]: TagTask: Finalizado.')
  }

  private async requestTagsFromGPT(photos: Photos[], task: TagTask, cleanedResults: string[]) {
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
          const hasPerson = tagList.some((t) => t.split('|')[1]?.trim() === 'person')
          if (!hasPerson) {
            tagList.push('no people | misc')
          }

          // Sacar sustantivos de ciertos grupos
          let sustantivesFromTag: string[] = []
          for (const tag of tagList) {
            const [tagName, group] = tag.split('|').map((i) => i.trim())
            if (['person', 'animals'].includes(group)) {
              const sustantives = this.nlpService.getSustantives(tagName)
              if (sustantives?.length) {
                sustantivesFromTag.push(...sustantives)
              }
            }
          }

          const tagsToSave = [...tagList, ...new Set(sustantivesFromTag)]
          task.data[photo.id] = []

          tagsToSave.forEach((tagStr) => {
            const [tag, group = 'misc'] = tagStr.split('|').map((i) => i.trim())
            const newTag = new Tag()
            newTag.name = tag
            newTag.group = group
            task.data[photo.id].push(newTag)
          })
        } catch (err) {
          console.log(`[AnalyzerProcess]: Error en ${task.name} -> ${err}`)
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

  private async filterAndSaveTags(photos: Photo[], task: TagTask) {
    const globalTagList = await Tag.all()

    for (const photo of photos) {
      const tagsToSaveForPhoto: Tag[] = []

      for (const tag of task.data[photo.id]) {
        await this.validateTag(tag, globalTagList, tagsToSaveForPhoto)
      }

      if (tagsToSaveForPhoto.length > 0) {
        const uniqueTagToSave = Array.from(
          new Map(tagsToSaveForPhoto.map((t) => [t.name.toLowerCase(), t])).values()
        )
        const category = task.descriptionSourceFields.join('_')

        // Primero, eliminar las relaciones de tags bajo la categoría actual.
        const attachedTags = await photo.related('tags').query()
        const tagIdsToDetach = attachedTags
          .filter((tag) => tag.$extras && tag.$extras.pivot_category === category)
          .map((tag) => tag.id)
        if (tagIdsToDetach.length > 0) {
          console.log(`[AnalyzerProcess]: Borrando tags de la categoría "${category}"...`)
          await photo.related('tags').detach(tagIdsToDetach)
        }

        // Construir el objeto con la categoría para los nuevos tags.
        const tagsWithCategory = uniqueTagToSave.reduce(
          (acc, t) => {
            acc[t.id] = { category }
            return acc
          },
          {} as Record<number, { category: string }>
        )

        console.log(`[AnalyzerProcess]: Añadiendo nuevos tags con categoría "${category}"...`)
        await photo.related('tags').attach(tagsWithCategory)
      }
    }
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

      for (const category of Object.keys(photo.descriptions)) {
        const description = photo.descriptions[category]
        if (!description) continue

        let descriptionChunks
        if (task.descriptionsChunksMethod[category] === 'split_by_pipes') {
          descriptionChunks = description.split('|').filter((ch: string) => ch.length > 0)
        } else {
          descriptionChunks = this.splitIntoChunks(description, description.length / 300)
        }

        await DescriptionChunk.query()
          .where('photoId', photo.id)
          .where('category', category)
          .delete()

        await Promise.all(
          descriptionChunks.map((chunk: string) =>
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
    const response = await this.retryCall(() =>
      this.modelsService.getGPTResponse(prompt, images, 'gpt-4o', null, 0)
    )
    return response || { result: [] }
  }

  private async executeMolmoTask(prompts: string[], batch: any[], task: VisionTask): Promise<any> {
    const response = await this.retryCall(() =>
      this.modelsService.getMolmoResponse(
        batch.map((pp) => ({ id: pp.photo.id, base64: pp.base64 })),
        [],
        prompts
      )
    )
    if (!response) return { result: [] }

    const { result } = response
    const homogenizedResult = result.map((res: any) => {
      const descriptionsByPrompt: { [key: string]: any } = {}
      task.promptsTarget.forEach((targetPrompt) => {
        const descObj = res.descriptions.find((d: any) => d.id_prompt === targetPrompt)
        descriptionsByPrompt[targetPrompt] = descObj ? descObj.description : null
      })
      return {
        id: res.id,
        ...descriptionsByPrompt,
      }
    })
    return { result: homogenizedResult }
  }

  // TODO: los tags deben compararse usando también el grupo (orange | fruit, orange | color)
  public async validateTag(
    tag: Tag,
    globalTagList: Tag[],
    tagsToSaveForPhoto: Tag[]
  ): Promise<void> {
    const tagNameLower = tag.name.toLowerCase()

    // Si es una stopword, se ignora la etiqueta.
    if (STOPWORDS.includes(tagNameLower)) {
      console.log('Ignoring tag: ', tag.name)
      return
    }

    // Si ya existe en la lista global, se añade y se retorna.
    const existingTag = globalTagList.find((t) => t.name === tagNameLower)
    if (existingTag) {
      tagsToSaveForPhoto.push(existingTag)
      console.log(`Using existing exact tag for ${tag.name}: ${existingTag.name}`)
      return
    }

    // Busca etiquetas similares.
    let similarTagsResult: any[] = []
    try {
      similarTagsResult =
        (await this.embeddingsService.findSimilarTagsToText(tag.name, 0.89, 5)) || []
    } catch (error) {
      console.log('Error in findSimilarTagsToText')
    }
    if (similarTagsResult.length > 0) {
      for (const similarTag of similarTagsResult) {
        const found = globalTagList.find((t) => t.name === similarTag.name.toLowerCase())
        if (found) {
          tagsToSaveForPhoto.push(found)
        }
      }
      console.log(
        `Using existing similar tags for ${tag.name}: ${JSON.stringify(similarTagsResult.map((t) => t.name))}`
      )
      return
    }

    // Si no se encontró etiqueta existente ni similar, se intenta guardar la nueva.
    try {
      await tag.save()
      tagsToSaveForPhoto.push(tag)
      globalTagList.push(tag)
    } catch (err: any) {
      if (err.code === '23505') {
        console.log(
          `Tried to save tag (${tag.name}) already existing in BD, fetching existing one.`
        )
        const concurrentTag = await Tag.query().where('name', tag.name).firstOrFail()
        tagsToSaveForPhoto.push(concurrentTag)
      } else {
        throw err
      }
    }
  }

  @MeasureExecutionTime
  public async createTagsEmbeddings() {
    // Recorremos todas las fotos y recogemos los tags sin embedding (sin duplicados)
    const allTagsMap = new Map<string, Tag>()
    for (const photo of this.process.photos) {
      await photo.load('tags')
      if (photo.tags && Array.isArray(photo.tags)) {
        for (const tag of photo.tags) {
          if (!tag.embedding) {
            const key = tag.name.toLowerCase()
            if (!allTagsMap.has(key)) {
              allTagsMap.set(key, tag)
            }
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
    // Asumimos que DescriptionChunk es el modelo y que ya existen registros en BD.
    // Se consultan los chunks que aún no tienen embedding asignado.
    const chunks = await DescriptionChunk.query().whereNull('embedding')

    for (let i = 0; i < chunks.length; i += 16) {
      const batch = chunks.slice(i, i + 16)
      const texts = batch.map((chunk) => chunk.chunk)
      const { embeddings } = await this.modelsService.getEmbeddings(texts)
      await Promise.all(
        batch.map((chunk, index) => {
          chunk.embedding = embeddings[index]
          return chunk.save()
        })
      )
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

  // caso de inyectar id's de fotos
  private async injectPromptsDpendencies(task: VisionTask, batch: PhotoImage[]): Promise<any> {
    let result = task.prompts

    if (task.model === 'Molmo') {
      const promptList = task.promptsTarget.map((target: DescriptionType, index: number) => ({
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
              text: p.prompt(photoImage.photo.descriptions[task.promptDependentField]),
            })),
          }
        })
      )
    } else {
      result = task.prompts.map((p) => p(batch.map((b) => b.photo))) // Inyección de ID por defecto
    }

    return result
  }

  private async getPendingPhotosForVisionTask(task: VisionTask): PhotoImage[] {
    await this.process.load('photos')
    let pendingPhotosIds = task.overwrite
      ? this.process.photos.map((p) => p.id)
      : this.process.photos
          .filter((p: Photo) => {
            let hasAllDescriptions = true
            for (const prompt of task.promptsTarget) {
              hasAllDescriptions =
                hasAllDescriptions && !!p.descriptions && !!p.descriptions[prompt]
            }
            return !hasAllDescriptions
          })
          .map((p) => p.id)

    return this.process.photoImages.filter((pi: PhotoImage) =>
      pendingPhotosIds.includes(pi.photo.id)
    )
  }

  private async getPendingPhotosForTagsTask(task: TagTask, isUpgradeOrRemake: boolean): Photo[] {
    await this.process.load('photos', (query) => {
      query.preload('tags')
    })
    let categoryName = task.descriptionSourceFields.join('_')
    return task.overwrite
      ? this.process.photos
      : this.process.photos.filter((p: Photo) => {
          return p.tags.filter((t: Tag) => t.category == categoryName).length == 0
        })
  }

  // Método auxiliar para dividir una descripción en chunks
  private splitIntoChunks(desc: string, numChunks: number = 5): string[] {
    const sentences = desc.split(/(?<=[.!?])\s+/)
    const totalSentences = sentences.length
    const chunkSize = Math.ceil(totalSentences / numChunks)
    const chunks: string[] = []
    for (let i = 0; i < totalSentences; i += chunkSize) {
      chunks.push(sentences.slice(i, i + chunkSize).join(' '))
    }
    return chunks
  }

  private async cleanPhotosDescs(
    photos: Photo[],
    descriptionFields: DescriptionType[],
    batchSize = 5,
    delayMs = 500
  ) {
    const results = []

    for (let i = 0; i < photos.length; i += batchSize) {
      const batch = photos.slice(i, i + batchSize)

      const [cleanResult] = await Promise.all([
        this.modelsService.cleanDescriptions(
          batch.map((photo) => {
            return this.getSourceTextFromPhoto(descriptionFields, photo)
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

  public getSourceTextFromPhoto(descriptionSourceFields: DescriptionType[], photo: Photo) {
    let text = ''
    for (const desc of descriptionSourceFields) {
      text += `${desc}: ${photo.descriptions?.[desc] ?? ''} |`
    }
    return text
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

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
