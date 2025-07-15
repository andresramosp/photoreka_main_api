import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import ModelsService from '../../services/models_service.js'
import AnalyzerProcess, { ProcessSheet } from './analyzerProcess.js'
import pLimit from 'p-limit'

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
  declare analyzerProcess: AnalyzerProcess
  failedRequests: PhotoImage[] = []

  async process(pendingPhotos: PhotoImage[], analyzerProcess: AnalyzerProcess): Promise<void> {
    this.analyzerProcess = analyzerProcess
    if (
      analyzerProcess.isFastMode ||
      (analyzerProcess.mode == 'retry_process' && pendingPhotos.length < 5)
    ) {
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
            url: `data:image/jpeg;base64,${photoImage.base64}`,
            detail: this.resolution,
          },
        }))
        requests.push({
          custom_id: customId,
          method: 'POST',
          url: '/v1/chat/completions',
          body: {
            model: 'gpt-4.1',
            temperature: 0.1,
            response_format: { type: 'json_object' },
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
      while (status === 'in_progress' || status === 'finalizing') {
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
        const content = res.response.body.choices[0].message.content
        const { results: parsed } = JSON.parse(content.replace(/```(?:json)?\s*/g, '').trim())

        const photoIds = res.custom_id.split('-').map(Number)

        if (!Array.isArray(parsed) || Math.random() < 0.2) {
          logger.error(`Error: la respuesta no es un array para el batch ${res.custom_id}`)
          // Agregar las imágenes fallidas a failedRequests
          const failedImages = batchPhotos.filter((img) => photoIds.includes(img.photo.id))
          this.failedRequests.push(...failedImages)
          return
        }

        parsed.forEach((photoResult: any, idx: number) => {
          const photoId = photoIds[idx]
          if (photoId) {
            this.data[photoId] = { ...this.data[photoId], ...photoResult }
          }
        })
      } catch (err) {
        logger.error(`Error procesando resultado del batch para fotos ${res.custom_id}:`, err)
      }
    })

    await this.commit(batchPhotos)
    logger.debug(`Datos salvados del batch para ${batchPhotos.length} imágenes`)
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
