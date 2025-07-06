import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import ModelsService from '../../services/models_service.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionDescriptionTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

export class VisionDescriptionTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare data: Record<number, Record<string, string>>
  declare complete: boolean
  declare useBatchAPI: boolean

  async process(pendingPhotos: PhotoImage[]): Promise<void> {
    if (this.useBatchAPI) {
      await this.processWithBatchAPI(pendingPhotos)
    } else {
      await this.processWithDirectAPI(pendingPhotos)
    }
  }

  private async processWithDirectAPI(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) this.data = {}

    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    const processBatch = async (batch: PhotoImage[], idx: number) => {
      await this.sleep(idx * 1500)

      let response: any
      const injectedPrompts: any = await this.injectPromptsDependencies(batch)
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
        logger.error(`Error en ${this.model} para ${batch.length} imágenes:`, err)
        return
      }

      response.result.forEach((res: any, photoIndex: number) => {
        const { ...results } = res
        const photoId = batch[photoIndex].photo.id
        this.data[photoId] = { ...this.data[photoId], ...results }
      })

      await this.commit(batch)
      logger.debug(`Datos salvados ${this.model} para ${batch.length} imágenes`)
    }

    if (this.sequential) {
      for (let i = 0; i < batches.length; i++) {
        await processBatch(batches[i], i)
      }
    } else {
      await Promise.all(batches.map((batch, idx) => processBatch(batch, idx)))
    }
  }

  private async processWithBatchAPI(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) this.data = {}

    const prompts = await this.injectPromptsDependencies(pendingPhotos)

    const requests = pendingPhotos.map((photoImage, idx) => {
      return {
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
          model: 'gpt-4o',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_tokens: 15000,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${photoImage.base64}`,
                    detail: this.resolution,
                  },
                },
                {
                  type: 'text',
                  text: Array.isArray(prompts) ? prompts[idx] : prompts,
                },
              ],
            },
          ],
        },
      }
    })

    const batchId = await this.modelsService.submitGPTBatch(requests)

    let status = 'in_progress'
    while (status === 'in_progress') {
      await this.sleep(3000)
      status = await this.modelsService.getBatchStatus(batchId)
    }

    if (status !== 'completed') {
      logger.error(`El batch ${batchId} ha fallado.`)
      return
    }

    const results = await this.modelsService.getBatchResults(batchId)

    results.forEach((res: any, idx: number) => {
      try {
        const content = res.response.choices[0].message.content
        const parsed = JSON.parse(content.replace(/```(?:json)?\s*/g, '').trim())
        const photoId = pendingPhotos[idx].photo.id
        this.data[photoId] = { ...this.data[photoId], ...parsed }
      } catch (err) {
        logger.error(
          `Error procesando resultado del batch para foto ${pendingPhotos[idx].photo.id}:`,
          err
        )
      }
    })

    await this.commit(pendingPhotos)
    logger.debug(`Datos salvados del batch para ${pendingPhotos.length} imágenes`)
  }

  async commit(batch: PhotoImage[]): Promise<void> {
    try {
      const photoManager = new PhotoManager()
      const photoIds = batch.map((p) => p.photo.id)

      await Promise.all(
        photoIds.map((photoId: number) => {
          const descriptions = this.data[photoId]
          if (!isNaN(Number(photoId)) && descriptions) {
            return photoManager.updatePhotoDescriptions(
              photoId.toString(),
              descriptions as PhotoDescriptions
            )
          }
          return Promise.resolve(null)
        })
      )

      for (const photoId of photoIds) {
        delete this.data[photoId]
      }
    } catch (err) {
      logger.error(`Error guardando datos de VisionTask:`, err)
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
            logger.error(`Error en Molmo para foto ${photoResult.id}:`, err)
          }
        })
        return {
          [this.promptsNames[0]]: descriptionsByPrompt,
        }
      }),
    }
  }

  private async injectPromptsDependencies(batch: PhotoImage[]): Promise<any> {
    if (this.promptDependentField || this.model === 'Molmo') {
      const promptList = this.promptsNames.map((target: DescriptionType, index: number) => ({
        id: target,
        prompt: this.prompts[index],
      }))

      return await Promise.all(
        batch.map(async (photoImage: PhotoImage) => {
          await photoImage.photo.refresh()
          return {
            id: photoImage.photo.id,
            prompts: promptList.map((p) => ({
              id: p.id,
              text: typeof p.prompt === 'function' ? p.prompt([photoImage.photo]) : p.prompt,
            })),
          }
        })
      )
    } else {
      return this.prompts.map((p) => (typeof p === 'function' ? p(batch.map((b) => b.photo)) : p))
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
