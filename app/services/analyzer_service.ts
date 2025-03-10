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

  public async initProcess(photos: Photo[], packageId: string) {
    const tasks = getTaskList(packageId)
    this.process.currentStage = 'init'
    this.process.tasks = tasks
    await this.process.save()
    await this.process.related('photos').updateOrCreateMany(photos)
    await this.process.load('photos')
    await this.process.populatePhotoImages()
  }

  public async *run() {
    if (!this.process || !this.process.tasks) {
      throw new Exception('[ERROR] No process found')
    }

    await this.changeStage('Process Started', 'vision_tasks')

    const visionTasks = this.process.tasks.filter((task) => task instanceof VisionTask)
    for (const task of visionTasks) {
      await this.executeVisionTask(task)
      await task.commit()
      await this.changeStage(`Task complete: ${task.name}`, 'vision_tasks')
    }

    await this.changeStage('Vision Tasks complete', 'tags_tasks')

    const tagsTasks = this.process.tasks.filter((task) => task instanceof TagTask)
    for (const task of tagsTasks) {
      await this.executeTagsTask(task)
      await task.commit()
      await this.changeStage(`Task complete: ${task.name}`, 'vision_tasks')
    }

    await this.changeStage('Tags Tasks complete', 'embeddings_tags')

    await this.createTagsEmbeddings()

    await this.changeStage('Tags Embeddings complete', 'chunks_tasks')

    const chunkTasks = this.process.tasks.filter((task) => task instanceof ChunkTask)
    for (const task of chunkTasks) {
      await this.executeChunksTask(task)
      await task.commit()
      await this.changeStage(`Task complete: ${task.name}`, 'vision_tasks')
    }

    await this.changeStage('Chunks Tags complete', 'embeddings_chunks')

    await this.createChunksEmbeddings()

    await this.changeStage('Chunks Embeddings complete', 'finished')

    // TODO: ver como gestionar procesos parciales
    yield { type: 'analysisComplete', data: { costs: [] } }
  }

  // @MeasureExecutionTime
  private async executeVisionTask(task: VisionTask) {
    if (!task.data) {
      task.data = {}
    }

    let pendingPhotoImages = await this.getPendingPhotosForTask(task)

    const imagesPerBatch =
      task.imagesPerBatch == 0 ? pendingPhotoImages.length : task.imagesPerBatch

    for (let i = 0; i < pendingPhotoImages.length; i += imagesPerBatch) {
      const batch = pendingPhotoImages.slice(i, i + imagesPerBatch)
      let response: any

      const injectedPrompts: any = await this.injectPromptsDpendencies(task, batch)

      response = await this[`execute${task.model}Task`](injectedPrompts, batch, task)

      for (const res of response.result) {
        const { id, ...descriptions } = res
        task.data[id] = { ...task.data[id], ...descriptions }
      }

      await this.sleep(750)
    }
  }

  // @MeasureExecutionTime
  private async executeTagsTask(task: TagTask) {
    if (!task.data) {
      task.data = {}
    }

    await this.process.load('photos')

    // 1. Limpiamos/resumimos descriptions para todas las fotos
    const cleanedResults = await this.cleanPhotosDescs(
      this.process.photos,
      task.descriptionSourceFields
    )

    // 2. Obtenemos los tags/gropos para todas las fotos
    const tagRequests = this.process.photos.map(async (photo, index) => {
      const cleanedText = cleanedResults[index]

      const { result: extractedTagsResponse, cost } = await this.modelsService.getGPTResponse(
        task.prompt as string,
        JSON.stringify({ description: cleanedText }),
        'gpt-4o-mini'
      )

      const { tags: tagList } = extractedTagsResponse

      // Verificar si existe el grupo "person"
      const hasPerson = tagList.some((tag: string) => tag.split('|')[1].trim() === 'person')
      if (!hasPerson) {
        tagList.push('no people | misc')
      }

      // 3. Sacar sustantivos de tags, solo de ciertos grupos
      let sustantivesFromTag: string[] = []
      for (let tag of tagList) {
        let [tagName, group] = tag.split('|').map((item: string) => item.trim())
        if (['person', 'animals'].includes(group)) {
          let sustantives = this.nlpService.getSustantives(tagName)
          if (sustantives?.length) sustantivesFromTag.push(...sustantives)
        }
      }

      let tagsToSave: string[] = []

      tagsToSave = [...tagList, ...sustantivesFromTag]

      task.data[photo.id] = []

      tagsToSave.forEach((tagStr: string) => {
        const [tag, group = 'misc'] = tagStr.split('|').map((item) => item.trim())
        let newTag = new Tag()
        newTag.name = tag
        newTag.group = group
        task.data[photo.id].push(newTag)
      })

      await this.sleep(index * 500)
    })

    await Promise.all(tagRequests)

    // 3. Filtramos la lista de tags para reusar aquellos que ya existan/se parezcan en BD (o entre sí)
    const globalTagList = await Tag.all()

    for (let photo of this.process.photos) {
      const tagsToSaveForPhoto: any[] = []
      for (let tag of task.data[photo.id]) {
        await this.validateTag(tag, globalTagList, tagsToSaveForPhoto)
      }
      if (tagsToSaveForPhoto.length > 0) {
        const uniqueTagToSave = Array.from(
          new Map(tagsToSaveForPhoto.map((tag) => [tag.name.toLowerCase(), tag])).values()
        )

        // OJO: esto siempre añade tags, poqrue se asume la posibilidad de tareas de tags secuenciales.
        // Para manejar el escenario overwrite / rehacer tags, habria que hacer un delete en un nivel superior
        await photo.related('tags').attach(uniqueTagToSave.map((tag) => tag.id))
      }
    }
  }

  // @MeasureExecutionTime
  public async executeChunksTask(task: ChunkTask) {
    if (!task.data) {
      task.data = {}
    }

    for (let photo of this.process.photos) {
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

  public async validateTag(tag: Tag, globalTagList: Array<Tag>, tagsToSaveForPhoto: Tag[]) {
    const isStopword = (tagName: string) => STOPWORDS.includes(tagName.toLowerCase())

    if (!isStopword(tag.name)) {
      let existingTag = globalTagList.find((t) => t.name == tag.name.toLowerCase())

      if (!existingTag) {
        let similarTagsResult: any
        try {
          similarTagsResult = await this.embeddingsService.findSimilarTagsToText(tag.name, 0.89, 5)
        } catch (err) {
          console.log('Error in findSimilarTagsToText')
        }

        if (similarTagsResult?.length > 0) {
          for (const similarTag of similarTagsResult) {
            const existingSimilarTag = globalTagList.find(
              (t) => t.name == similarTag.name.toLowerCase()
            )
            if (existingSimilarTag) {
              tagsToSaveForPhoto.push(existingSimilarTag)
            }
          }
          console.log(
            `Using existing similar tags for ${tag.name}: ${JSON.stringify(similarTagsResult.map((tag: any) => tag.name))}`
          )
          return
        }
      }

      if (!existingTag) {
        try {
          await tag.save()
          tagsToSaveForPhoto.push(tag)
          globalTagList.push(tag)
        } catch (err) {
          if (err.code === '23505') {
            console.log(`Tag ${tag.name} already exists, fetching existing one.`)
            const concurrentBDTag = await Tag.query().where('name', tag.name).firstOrFail()
            tagsToSaveForPhoto.push(concurrentBDTag)
          } else {
            throw err
          }
        }
      }
      if (existingTag) tagsToSaveForPhoto.push(existingTag)
    } else {
      console.log('Ignoring tag: ', tag.name)
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

  private async changeStage(message: string, nextStage: StageType) {
    ws.io?.emit('stageChanged', { message })
    this.process.currentStage = nextStage
    await this.process.save()
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

  private async getPendingPhotosForTask(task: VisionTask): PhotoImage[] {
    await this.process.load('photos')
    let pendingPhotosIds = task.overwrite
      ? this.process.photos
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
