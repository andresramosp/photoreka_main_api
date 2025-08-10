import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import AnalyzerProcess, { ProcessSheet } from './analyzerProcess.js'
import pLimit from 'p-limit'
import { createUserContent, MediaResolution } from '@google/genai'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionDescriptionTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

const batchDelay = 1500 // Delay between batches in milliseconds

export class VisionDescriptionTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high' | 'medium'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare data: Record<number, Record<string, string>>
  declare complete: boolean
  declare analyzerProcess: AnalyzerProcess
  declare visualAspects: boolean
  failedRequests: PhotoImage[] = []

  async process(pendingPhotos: PhotoImage[], analyzerProcess: AnalyzerProcess): Promise<void> {
    this.analyzerProcess = analyzerProcess
    if (analyzerProcess.isFastMode || pendingPhotos.length < 10) {
      await this.processWithDirectAPI(pendingPhotos)
    } else {
      await this.processWithBatchAPI(pendingPhotos)
    }
  }

  private async processWithDirectAPI(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) this.data = {}

    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    const maxConcurrency = 5 // Número de batches simultáneos
    const limit = pLimit(maxConcurrency)

    const processBatch = async (batch: PhotoImage[]) => {
      let response: any
      const injectedPrompts: any = await this.injectPromptsDependencies(batch)
      logger.debug(`Llamando a ${this.model} para ${batch.length} imágenes...`)

      try {
        if (this.model === 'GPT' || this.model === 'Qwen' || this.model === 'Gemini') {
          response = await this.executeModelTask(injectedPrompts, batch)
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
        await processBatch(batches[i])
      }
    } else {
      await Promise.all(batches.map((batch) => limit(() => processBatch(batch))))
    }
  }

  private async processWithDirectAPIDelayed(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) this.data = {}

    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    const processBatch = async (batch: PhotoImage[], idx: number) => {
      await this.sleep(idx * batchDelay)

      let response: any
      const injectedPrompts: any = await this.injectPromptsDependencies(batch)
      logger.debug(`Llamando a ${this.model} para ${batch.length} imágenes...`)

      try {
        if (this.model === 'GPT' || this.model === 'Qwen' || this.model === 'Gemini') {
          response = await this.executeModelTask(injectedPrompts, batch)
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

    const imagesPerBatch = 200
    const maxConcurrency = 5 // Número de batches simultáneos

    // Divide las fotos en batches de 200
    const batches: PhotoImage[][] = []
    for (let i = 0; i < pendingPhotos.length; i += imagesPerBatch) {
      batches.push(pendingPhotos.slice(i, i + imagesPerBatch))
    }

    const limit = pLimit(maxConcurrency)

    // Ejecuta todos los batches con concurrencia limitada
    const batchPromises = batches.map((batchPhotos) =>
      limit(() => this.processSingleBatch(batchPhotos))
    )

    await Promise.all(batchPromises)

    // Si hay fallos, reprocesar con DirectAPI
    if (this.failedRequests.length > 0) {
      logger.warn(`Reprocesando ${this.failedRequests.length} imágenes fallidas con DirectAPI`)
      await this.processWithDirectAPI(this.failedRequests)
      this.failedRequests = []
    }
  }

  async commit(batch: PhotoImage[]): Promise<void> {
    try {
      const photoManager = new PhotoManager()
      const photoIds = batch.map((p) => p.photo.id)

      await Promise.all(
        photoIds.map((photoId: number) => {
          const descriptions = this.visualAspects
            ? { visual_aspects: this.data[photoId] }
            : this.data[photoId]
          if (!isNaN(Number(photoId)) && this.data[photoId]) {
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

  private async processSingleBatch(batchPhotos: PhotoImage[]): Promise<void> {
    const prompts = await this.injectPromptsDependencies(batchPhotos)
    const imagesPerRequest = 4
    const maxRetries = 3
    let attempt = 0
    let completed = false
    let batchId: string | null = null
    let status = 'in_progress'
    let requests: any[] = []

    while (attempt < maxRetries && !completed) {
      // Generar requests en cada intento para evitar side effects
      requests = []
      for (let j = 0; j < batchPhotos.length; j += imagesPerRequest) {
        const batch = batchPhotos.slice(j, j + imagesPerRequest)
        const customId = batch.map((p) => p.photo.id).join('-')
        const userContent = batch.map((photoImage) => ({
          type: 'image_url',
          image_url: {
            url: photoImage.photo.originalUrl,
            detail: this.resolution,
          },
        }))
        requests.push({
          custom_id: customId,
          method: 'POST',
          url: '/v1/chat/completions',
          body: {
            model: 'gpt-4.1', // 'gpt-5-chat-latest' no soporta aun Batch API y el gpt-5 desvaría.
            temperature: 0.1,
            // response_format: { type: 'json_object' },
            max_tokens: 15000,
            messages: [
              { role: 'system', content: prompts[0] },
              { role: 'user', content: userContent },
            ],
          },
        })
      }

      batchId = await this.modelsService.submitGPTBatch(requests)
      logger.debug(
        `Batch con id ${batchId} en espera para ${batchPhotos.length} imágenes (intento ${attempt + 1}/${maxRetries})`
      )

      status = 'in_progress'
      // Espera hasta que el batch cambie de estado o se agoten los reintentos
      while (status === 'in_progress' || status === 'finalizing' || status === 'validating') {
        await this.sleep(5000)
        status = await this.modelsService.getBatchStatus(batchId)
      }
      if (status === 'completed') {
        completed = true
      } else {
        attempt++
        if (attempt < maxRetries) {
          logger.warn(
            `El batch ${batchId} no se completó (status: ${status}). Reintentando (${attempt}/${maxRetries})...`
          )
        }
      }
    }

    if (!completed || !batchId) {
      logger.error(
        `El batch${batchId ? ' ' + batchId : ''} ha fallado tras ${maxRetries} reintentos.`
      )
      return
    }

    logger.debug(`Batch con id ${batchId} resuelto`)

    const results = await this.modelsService.getBatchResults(batchId)

    results.forEach((res: any) => {
      try {
        const items = res.items || []
        const photoIds = res.custom_id.split('-').map(Number)
        if (items.length !== photoIds.length) {
          logger.error(`Batch mismatch ${res.custom_id}: ${items.length} vs ${photoIds.length}`)
          this.failedRequests.push(...batchPhotos.filter((img) => photoIds.includes(img.photo.id)))
          return
        }
        items.forEach((photoResult: any, idx: number) => {
          const photoId = photoIds[idx]
          this.data[photoId] = { ...this.data[photoId], ...photoResult }
        })
      } catch (err) {
        logger.error(`Error procesando resultado del batch para fotos ${res.custom_id}:`, err)
      }
    })

    await this.commit(batchPhotos)
    logger.debug(`Datos salvados del batch para ${batchPhotos.length} imágenes`)
  }

  private async executeModelTask(prompts: string[], batch: PhotoImage[]): Promise<any> {
    const prompt = prompts[0]

    if (this.model === 'GPT') {
      const images = batch.map((pp) => ({
        type: 'image_url',
        image_url: {
          url: pp.photo.originalUrl,
          detail: this.resolution,
        },
      }))
      return await this.modelsService.getGPTResponse(prompt, images, 'gpt-5-chat-latest', null, 0)
    } else if (this.model === 'Qwen') {
      const images = batch.map((pp) => ({
        type: 'image_url',
        image_url: {
          url: pp.photo.originalUrl,
          detail: this.resolution,
        },
      }))
      return await this.modelsService.getQwenResponse(prompt, images, 'qwen-vl-max', null, 0)
    } else if (this.model === 'Gemini') {
      let images = batch.map((pp) => ({
        inlineData: {
          mimeType: 'image/png',
          data: pp.base64,
        },
      }))

      return await this.modelsService.getGeminiResponse(prompt, images, this.modelName, {
        temperature: 0.1,
        mediaResolution:
          this.resolution == 'high'
            ? MediaResolution.MEDIA_RESOLUTION_HIGH
            : MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      })
    } else {
      throw new Error(`Modelo no soportado: ${this.model}`)
    }
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
