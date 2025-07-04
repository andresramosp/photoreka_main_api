import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionTopologicalTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

export class VisionTopologicalTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare data: Record<string, Record<string, string>>
  declare complete: boolean

  async process(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    for (const photoImage of pendingPhotos) {
      await photoImage.photo.load('tags', (query) => query.preload('tag'))
    }

    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    if (this.sequential) {
      for (let i = 0; i < batches.length; i++) {
        await this.processBatch(batches[i], i)
      }
    } else {
      await Promise.all(batches.map((batch, idx) => this.processBatch(batch, idx)))
    }
  }

  async processBatch(batch: PhotoImage[], idx: number) {
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
    } catch (err) {
      logger.error(`Error en ${this.model} para ${batch.length} imágenes:`)
      return
    }

    response.result.forEach((res: any, photoIndex: number) => {
      const { ...results } = res
      const photoId = batch[photoIndex].photo.id
      this.data[photoId] = { ...this.data[photoId], ...results }
    })

    await this.commit(batch)
  }

  async commit(batch: PhotoImage[]): Promise<void> {
    try {
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

      const photoIds = batch.map((p) => p.photo.id)
      await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)

      for (const photoId of photoIds) {
        delete this.data[photoId]
      }

      logger.debug(`Completada tarea ${this.model} para ${batch.length} imágenes`)
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
