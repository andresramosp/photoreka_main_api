import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import PhotoImageService from '../../services/photo_image_service.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import AnalyzerProcess from './analyzerProcess.js'
import ModelsService from '../../services/models_service.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

export class VisionTopologicalTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare useGuideLines: boolean
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare data: Record<string, Record<string, string>>
  declare complete: boolean

  private photoImageService: PhotoImageService
  private modelsService: ModelsService

  constructor() {
    super()
    this.photoImageService = PhotoImageService.getInstance()
    this.modelsService = new ModelsService()
  }

  async prepare(process: AnalyzerProcess): Promise<PhotoImage[]> {
    const allImages = await this.photoImageService.getPhotoImages(process, this.useGuideLines)
    for (const photoImage of allImages) {
      await photoImage.photo.load('tags', (query) => query.preload('tag'))
    }
    if (process.mode === 'retry') {
      const failedPhotos = Object.entries(process.failed)
        .filter(([_, taskName]) => taskName === this.name)
        .map(([photoId]) => photoId)

      return allImages.filter((img) => failedPhotos.includes(img.photo.id))
    }

    return allImages
  }

  async process(process: AnalyzerProcess, pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    const processBatch = async (batch: PhotoImage[], idx: number) => {
      await this.sleep(idx * 1500)

      let response: any
      const injectedPrompts: any = this.prompts.map((p) =>
        typeof p === 'function' ? p(batch.map((b) => b.photo)) : p
      )
      logger.debug(`Llamando a ${this.model} para ${batch.length} imágenes...`)

      try {
        if (this.model === 'GPT') {
          response = await this.executeGPTTask(injectedPrompts, batch)
        } else if (this.model === 'Molmo') {
          response = await this.executeMolmoTask(injectedPrompts, batch)
        } else {
          throw new Error(`Modelo no soportado: ${this.model}`)
        }

        if (process.mode === 'retry') {
          process.removeFailedPhotos(
            batch.map((b) => b.photo.id),
            this.name
          )
        }
      } catch (err) {
        logger.error(`Error en ${this.model} para ${batch.length} imágenes:`)
        process.addFailedPhotos(
          batch.map((b) => b.photo.id),
          this.name
        )
        return
      }

      response.result.forEach((res: any, photoIndex: number) => {
        const { ...results } = res
        const photoId = batch[photoIndex].photo.id
        this.data[photoId] = { ...this.data[photoId], ...results }
      })

      await this.commit()
      logger.debug(`Completada tarea ${this.model} para ${batch.length} imágenes`)
    }

    if (this.sequential) {
      for (let i = 0; i < batches.length; i++) {
        await processBatch(batches[i], i)
      }
    } else {
      await Promise.all(batches.map((batch, idx) => processBatch(batch, idx)))
    }
  }

  async commit(): Promise<void> {
    try {
      const photoManager = new PhotoManager()
      const tagPhotoManager = new TagPhotoManager()

      await Promise.all(
        Object.entries(this.data)
          .map(([photoId, tagPhotos]) => {
            if (!isNaN(Number(photoId))) {
              const targetField = 'area'
              const tagPhotosToUpdate = Object.entries(tagPhotos).map(([id, value]) => ({
                id: Number(id),
                [targetField]: value,
              }))

              return tagPhotosToUpdate.map((tagPhotoDelta) =>
                tagPhotoManager.updateTagPhoto(tagPhotoDelta.id, {
                  [targetField]: tagPhotoDelta[targetField],
                })
              )
            }
            return []
          })
          .flat()
      )
    } catch (err) {
      logger.error(`Error guardando datos de VisionTask:`)
    }
  }

  private async executeGPTTask(prompts: string[], batch: PhotoImage[]): Promise<any> {
    const prompt = prompts[0]
    const images = batch.map((pp) => ({
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${pp.base64}`,
        detail: this.resolution,
      },
    }))
    return await this.modelsService.getGPTResponse(prompt, images, 'gpt-4.1', null, 0)
  }

  private async executeMolmoTask(prompts: any[], batch: PhotoImage[]): Promise<any> {
    const response = await this.modelsService.getMolmoResponse(
      batch.map((pp) => ({ id: pp.photo.id, base64: pp.base64 })),
      [],
      prompts
    )
    if (!response) return { result: [] }

    const { result } = response
    return {
      result: result.map((photoResult: any) => {
        let descriptionsByPrompt: { [key: string]: any } = {}
        this.promptsNames.forEach((targetPrompt) => {
          try {
            const descObj = photoResult.descriptions.find((d: any) => d.id_prompt === targetPrompt)
            descriptionsByPrompt = descObj.description
          } catch (err) {
            logger.error(`Error en Molmo para foto ${photoResult.id}:`)
          }
        })
        return {
          [this.promptsNames[0]]: descriptionsByPrompt,
        }
      }),
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
