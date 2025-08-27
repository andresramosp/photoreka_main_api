import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import TagPhotoManager from '../../managers/tag_photo_manager.js'
import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import AnalyzerProcess from './analyzerProcess.js'
import pLimit from 'p-limit'
import { MediaResolution } from '@google/genai'
import PhotoImageService from '../../services/photo_image_service.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisionTopologicalTask')
logger.setLevel(LogLevel.DEBUG)

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

export class VisionTopologicalTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high'
  declare sequential: boolean
  declare imagesPerRequest: number
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare useGuideLines: boolean
  declare data: Record<string, Record<string, string>>
  declare complete: boolean
  declare analyzerProcess: AnalyzerProcess
  failedRequests: Photo[] = []

  async process(pendingPhotos: Photo[], analyzerProcess: AnalyzerProcess): Promise<void> {
    this.analyzerProcess = analyzerProcess
    // Limpiar requests fallidos al inicio del proceso
    this.failedRequests = []

    const filteredPhotos: Photo[] = await this.filterNonVerticalPhotos(pendingPhotos)
    if (this.model == 'Gemini' || analyzerProcess.isFastMode || pendingPhotos.length < 10) {
      await this.processWithDirectAPI(filteredPhotos)
    } else {
      await this.processWithBatchAPI(filteredPhotos)
    }

    // Limpiar al final del proceso completo
    this.failedRequests = []
  }

  private async processWithDirectAPI(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    // Cargar tags y filtrar solo fotos con tags
    const validPhotos: Photo[] = []
    const skippedPhotoIds: number[] = []

    for (const photo of pendingPhotos) {
      await photo.load('tags', (query) => query.preload('tag'))
      // Saltar si no hay tags
      if (!photo.tags || photo.tags.length === 0) {
        skippedPhotoIds.push(photo.id)
      } else {
        validPhotos.push(photo)
      }
    }

    if (skippedPhotoIds.length > 0) {
      logger.info(
        `Saltando ${skippedPhotoIds.length} fotos sin tags: ${skippedPhotoIds.join(', ')}`
      )
    }
    if (validPhotos.length === 0) {
      logger.warn('No hay fotos válidas para procesar.')
      // Limpiar arrays antes de retornar
      validPhotos.length = 0
      skippedPhotoIds.length = 0
      return
    }

    const batches: Photo[][] = []
    for (let i = 0; i < validPhotos.length; i += this.imagesPerRequest) {
      const batch = validPhotos.slice(i, i + this.imagesPerRequest)
      batches.push(batch)
    }

    // Limpiar arrays después de crear batches
    validPhotos.length = 0
    skippedPhotoIds.length = 0

    if (this.sequential) {
      for (let i = 0; i < batches.length; i++) {
        await this.processBatch(batches[i], i)
        // Limpiar la referencia del batch procesado
        batches[i] = []
      }
    } else {
      await Promise.all(batches.map((batch, idx) => this.processBatch(batch, idx)))
    }

    // Limpiar array de batches
    batches.length = 0
  }

  private async processWithBatchAPI(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    // Cargar tags y filtrar solo fotos con tags
    const validPhotos: Photo[] = []
    const skippedPhotoIds: number[] = []

    for (const photo of pendingPhotos) {
      await photo.load('tags', (query) => query.preload('tag'))
      // Saltar si no hay tags
      if (!photo.tags || photo.tags.length === 0) {
        skippedPhotoIds.push(photo.id)
      } else {
        validPhotos.push(photo)
      }
    }

    if (skippedPhotoIds.length > 0) {
      logger.info(
        `Saltando ${skippedPhotoIds.length} fotos sin tags: ${skippedPhotoIds.join(', ')}`
      )
    }
    if (validPhotos.length === 0) {
      logger.warn('No hay fotos válidas para procesar.')
      // Limpiar arrays antes de retornar
      validPhotos.length = 0
      skippedPhotoIds.length = 0
      return
    }

    const imagesPerBatch = 200
    const maxConcurrency = 5 // Número de batches simultáneos

    // Divide las fotos en batches de 200
    const batches: Photo[][] = []
    for (let i = 0; i < validPhotos.length; i += imagesPerBatch) {
      batches.push(validPhotos.slice(i, i + imagesPerBatch))
    }

    // Limpiar arrays después de crear batches
    validPhotos.length = 0
    skippedPhotoIds.length = 0

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

  async processBatch(batch: Photo[], idx: number) {
    await this.sleep(idx * 1500)

    let response: any
    const injectedPrompts: any = this.prompts.map((p) => (typeof p === 'function' ? p(batch) : p))
    logger.debug(`Llamando a ${this.model} para ${batch.length} imágenes...`)

    try {
      if (this.model === 'GPT' || this.model === 'Qwen' || this.model === 'Gemini') {
        response = await this.executeModelTask(injectedPrompts, batch)
      } else {
        throw new Error(`Modelo no soportado: ${this.model}`)
      }
      response.result.forEach((res: any, photoIndex: number) => {
        const { ...results } = res
        const photoId = batch[photoIndex].id
        this.data[photoId] = { ...this.data[photoId], ...results }
      })

      // Limpiar prompts inyectados después del uso
      injectedPrompts.length = 0

      await this.commit(batch)
    } catch (err) {
      logger.error(`Error en ${this.model} para ${batch.length} imágenes:`)
      return
    }
  }

  async commit(batch: Photo[]): Promise<void> {
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

      const photoIds = batch.map((p) => p.id)
      await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)

      for (const photoId of photoIds) {
        delete this.data[photoId]
      }

      logger.debug(`Completada tarea ${this.model} para ${batch.length} imágenes`)
    } catch (err) {
      logger.error(`Error guardando datos de VisionTask: ${err}`)
    }
  }

  private async processSingleBatch(batchPhotos: Photo[]): Promise<void> {
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

        // ✅ Generar prompt específico para este sub-batch de 4 fotos
        const batchSpecificPrompts = this.prompts.map((p) =>
          typeof p === 'function' ? p(batch) : p
        )

        const userContent = batch.map((photo) => ({
          type: 'image_url',
          image_url: {
            url: photo.originalUrl,
            // url: `data:image/jpeg;base64,${photoImage.base64}`,
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
              { role: 'system', content: batchSpecificPrompts[0] },
              { role: 'user', content: userContent },
            ],
          },
        })

        // Limpiar arrays temporales después de crear cada request
        batchSpecificPrompts.length = 0
        userContent.length = 0
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
        const photoIds = res.custom_id.split('-').map(Number)
        const items = res.items || []
        if (items.length !== photoIds.length) {
          logger.error(`Batch mismatch ${res.custom_id}: ${items.length} vs ${photoIds.length}`)
          const failedImages = batchPhotos.filter((photo) => photoIds.includes(photo.id))
          this.failedRequests.push(...failedImages)
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

    if (this.model === 'GPT') {
      const images = batch.map((photo) => ({
        type: 'image_url',
        image_url: {
          url: photo.originalUrl,
          detail: this.resolution,
        },
      }))
      const result = await this.modelsService.getGPTResponse(
        prompt,
        images,
        'gpt-5-chat-latest',
        null,
        0
      )

      // Limpiar array de imágenes
      images.length = 0
      return result
    } else if (this.model === 'Qwen') {
      const images = batch.map((photo) => ({
        type: 'image_url',
        image_url: {
          url: photo.originalUrl,
          detail: this.resolution,
        },
      }))
      const result = await this.modelsService.getQwenResponse(
        prompt,
        images,
        'qwen-vl-max',
        null,
        0
      )

      // Limpiar array de imágenes
      images.length = 0
      return result
    } else if (this.model === 'Gemini') {
      const photoImageService = PhotoImageService.getInstance()

      // Obtener imágenes válidas, automáticamente filtra las que no están en R2
      const validImages = await photoImageService.getValidPhotosWithImages(
        batch,
        this.useGuideLines
      )

      // Marcar las fotos fallidas como completadas (opcional)
      const failedPhotos = batch.filter(
        (photo) => !validImages.some((vi) => vi.photo.id === photo.id)
      )
      if (failedPhotos.length > 0) {
        logger.debug(`${failedPhotos.length} fotos no disponibles en R2, continuando sin ellas`)
      }

      if (validImages.length === 0) {
        logger.debug('No hay imágenes válidas para este batch')
        return { result: [] }
      }

      // Convertir al formato esperado por Gemini
      const images = validImages.map(({ base64 }) => ({
        inlineData: {
          mimeType: 'image/png',
          data: base64,
        },
      }))

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

      return result
    } else {
      throw new Error(`Modelo no soportado: ${this.model}`)
    }
  }

  private async filterNonVerticalPhotos(pendingPhotos: Photo[]): Promise<Photo[]> {
    const filteredPhotos: Photo[] = []
    for (const photo of pendingPhotos) {
      // Refrescar la foto para asegurar que descriptions esté actualizado
      if (typeof photo.refresh === 'function') {
        await photo.refresh()
      }
      const descriptions = photo.descriptions
      if (!descriptions || !descriptions.visual_aspects) continue
      const visualAspects = descriptions.visual_aspects
      if (typeof visualAspects !== 'object' || Array.isArray(visualAspects)) continue
      const orientation = (visualAspects as any)?.orientation
      if (!orientation) continue
      if (Array.isArray(orientation)) {
        if (orientation.includes('horizontal')) {
          filteredPhotos.push(photo)
        }
      } else if (orientation === 'horizontal') {
        filteredPhotos.push(photo)
      }
    }
    return filteredPhotos
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
