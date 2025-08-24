import { DescriptionType, PhotoDescriptions } from '#models/photo'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import AnalyzerProcess from './analyzerProcess.js'
import pLimit from 'p-limit'
import { MediaResolution } from '@google/genai'
import PhotoImageService from '../../services/photo_image_service.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionDescriptionTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

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
  failedRequests: Photo[] = []

  async process(pendingPhotos: Photo[], analyzerProcess: AnalyzerProcess): Promise<void> {
    this.analyzerProcess = analyzerProcess
    // Limpiar requests fallidos al inicio del proceso
    this.failedRequests = []

    if (this.batchAPI && pendingPhotos.length >= this.imagesPerBatch) {
      await this.processWithBatchAPI(pendingPhotos)
    } else {
      await this.processWithDirectAPI(pendingPhotos)
    }

    // Limpiar al final del proceso completo
    this.failedRequests = []
  }

  private async processWithDirectAPI(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) this.data = {}

    const batches: Photo[][] = []
    for (let i = 0; i < pendingPhotos.length; i += this.imagesPerBatch) {
      const batch = pendingPhotos.slice(i, i + this.imagesPerBatch)
      batches.push(batch)
    }

    const maxConcurrency = 5 // Número de batches simultáneos
    const limit = pLimit(maxConcurrency)

    const processBatch = async (batch: Photo[]) => {
      let response: any
      const injectedPrompts: any = this.prompts.map((p) => (typeof p === 'function' ? p(batch) : p))
      logger.debug(`Llamando a ${this.model} para ${batch.length} imágenes...`)

      try {
        if (this.model === 'GPT' || this.model === 'Qwen' || this.model === 'Gemini') {
          response = await this.executeModelTask(injectedPrompts, batch)
        } else {
          throw new Error(`Modelo no soportado: ${this.model}`)
        }
      } catch (err) {
        logger.error(`Error en ${this.model} para ${batch.length} imágenes:`, err)
        return
      }

      // Manejar el caso donde response puede tener menos resultados debido a errores
      if (response && response.result && response.result.length > 0) {
        if (this.model === 'Gemini' && response.validPhotos) {
          // Para Gemini, usamos las fotos válidas identificadas
          response.result.forEach((res: any, photoIndex: number) => {
            const { ...results } = res
            const photoId = response.validPhotos[photoIndex].id
            this.data[photoId] = { ...this.data[photoId], ...results }
          })
          await this.commit(response.validPhotos)
        } else {
          // Para otros modelos o cuando no hay validPhotos, usar la lógica original
          response.result.forEach((res: any, photoIndex: number) => {
            const { ...results } = res
            const photoId = batch[photoIndex].id
            this.data[photoId] = { ...this.data[photoId], ...results }
          })
          await this.commit(batch)
        }
        logger.debug(`Datos salvados ${this.model} para ${response.result.length} imágenes`)
      } else {
        logger.warn(`No se obtuvieron resultados válidos para el batch de ${batch.length} imágenes`)
      }
    }

    if (this.sequential) {
      for (let i = 0; i < batches.length; i++) {
        await processBatch(batches[i])
        // Limpiar la referencia del batch procesado
        batches[i] = []
      }
    } else {
      await Promise.all(batches.map((batch) => limit(() => processBatch(batch))))
    }

    // Limpiar array de batches
    batches.length = 0
  }

  private async processWithBatchAPI(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) this.data = {}

    const imagesPerBatch = 200
    const maxConcurrency = 5 // Número de batches simultáneos

    // Divide las fotos en batches de 200
    const batches: Photo[][] = []
    for (let i = 0; i < pendingPhotos.length; i += imagesPerBatch) {
      batches.push(pendingPhotos.slice(i, i + imagesPerBatch))
    }

    const limit = pLimit(maxConcurrency)

    // Ejecuta todos los batches con concurrencia limitada
    const batchPromises = batches.map((batchPhotos) =>
      limit(() => this.processSingleBatch(batchPhotos))
    )

    await Promise.all(batchPromises)

    // Limpiar array de batches
    batches.length = 0

    // Si hay fallos, reprocesar con DirectAPI
    if (this.failedRequests.length > 0) {
      logger.warn(`Reprocesando ${this.failedRequests.length} imágenes fallidas con DirectAPI`)
      await this.processWithDirectAPI(this.failedRequests)
      this.failedRequests = []
    }
  }

  async commit(batch: Photo[]): Promise<void> {
    try {
      const photoManager = new PhotoManager()
      const photoIds = batch.map((p) => p.id)

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

  private async processSingleBatch(batchPhotos: Photo[]): Promise<void> {
    const prompts = this.prompts.map((p) => (typeof p === 'function' ? p(batchPhotos) : p))
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
        const customId = batch.map((p) => p.id).join('-')
        const userContent = batch.map((photo) => ({
          type: 'image_url',
          image_url: {
            url: photo.originalUrl,
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
          this.failedRequests.push(...batchPhotos.filter((photo) => photoIds.includes(photo.id)))
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

    // Limpiar results para liberar memoria
    results.length = 0

    await this.commit(batchPhotos)
    logger.debug(`Datos salvados del batch para ${batchPhotos.length} imágenes`)
  }

  private async executeModelTask(prompts: string[], batch: Photo[]): Promise<any> {
    const prompt = prompts[0]

    try {
      if (this.model === 'GPT') {
        const images = batch.map((photo) => ({
          type: 'image_url',
          image_url: {
            url: photo.originalUrl,
            detail: this.resolution,
          },
        }))
        return await this.modelsService.getGPTResponse(
          prompt,
          images,
          'gpt-5-chat-latest',
          null,
          0,
          false
        )
      } else if (this.model === 'Qwen') {
        const images = batch.map((photo) => ({
          type: 'image_url',
          image_url: {
            url: photo.originalUrl,
            detail: this.resolution,
          },
        }))
        return await this.modelsService.getQwenResponse(
          prompt,
          images,
          'qwen-vl-max',
          null,
          0,
          false
        )
      } else if (this.model === 'Gemini') {
        const photoImageService = PhotoImageService.getInstance()

        // Obtener imágenes válidas, automáticamente filtra las que no están en R2
        const validImages = await photoImageService.getValidPhotosWithImages(batch, false)

        // Marcar las fotos fallidas como completadas (opcional, si quieres hacerlo aquí)
        const failedPhotos = batch.filter(
          (photo) => !validImages.some((vi) => vi.photo.id === photo.id)
        )
        if (failedPhotos.length > 0) {
          logger.debug(`${failedPhotos.length} fotos no disponibles en R2, continuando sin ellas`)
        }

        if (validImages.length === 0) {
          logger.warn('No se pudieron obtener imágenes para ninguna foto del batch')
          return { result: [] }
        }

        // Convertir al formato esperado por Gemini
        const imagesWithIds = validImages.map(({ photo, base64 }) => ({
          photo,
          imageData: {
            inlineData: {
              mimeType: 'image/png',
              data: base64,
            },
          },
        }))

        const images = imagesWithIds.map((item) => item.imageData)
        const validPhotos = imagesWithIds.map((item) => item.photo)

        const result = await this.modelsService.getGeminiResponse(
          prompt,
          images,
          this.modelName,
          {
            temperature: 0.1,
            mediaResolution:
              this.resolution == 'high'
                ? MediaResolution.MEDIA_RESOLUTION_HIGH
                : MediaResolution.MEDIA_RESOLUTION_MEDIUM,
          },
          false
        )

        // Limpiar las imágenes de memoria de forma más agresiva
        images.forEach((img) => (img.inlineData.data = ''))
        images.length = 0

        // Ajustar el resultado para que coincida con las fotos válidas
        if (result && result.result) {
          result.validPhotos = validPhotos // Agregar info de qué fotos son válidas
        }

        return result
      } else {
        throw new Error(`Modelo no soportado: ${this.model}`)
      }
    } catch (error) {
      logger.error(`Error en executeModelTask para modelo ${this.model}:`, error)
      // En lugar de lanzar el error, retornamos un resultado vacío para continuar
      return { result: [] }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
