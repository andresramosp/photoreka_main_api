import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'
import PhotoImageService from '#services/photo_image_service'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualEmbeddingTask')
logger.setLevel(LogLevel.DEBUG)

type EmbeddingResponse = {
  id: string
  embedding: number[]
}

export class VisualEmbeddingTask extends AnalyzerTask {
  // Map photoId to its PhotoImage instance and embedding array
  declare data: Record<string, { pi: Photo; embedding: number[] }>

  async process(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    const batchSize = 12

    let photosToProcess = pendingPhotos
    if (this.onlyIfNeeded) {
      photosToProcess = pendingPhotos.filter((pi) => pi.embedding == null)
    }
    const photoImageService = PhotoImageService.getInstance()
    for (let i = 0; i < photosToProcess.length; i += batchSize) {
      await this.sleep(250)
      const batch = photosToProcess.slice(i, i + batchSize)

      // Obtener las imágenes válidas, automáticamente filtra las que no están en R2
      const validImages = await photoImageService.getValidPhotosWithImages(batch, false)

      // Marcar las fotos fallidas como completadas
      const failedPhotos = batch.filter(
        (photo) => !validImages.some((vi) => vi.photo.id === photo.id)
      )
      if (failedPhotos.length > 0) {
        const failedIds = failedPhotos.map((p) => p.id)
        await this.analyzerProcess.markPhotosCompleted(this.name, failedIds)
      }

      if (validImages.length === 0) {
        logger.debug(`No hay imágenes válidas en el batch, continuando...`)
        continue
      }

      // Convertir al formato esperado por el servicio de embeddings
      const payload = validImages.map(({ photo, base64 }) => ({ id: photo.id, base64 }))
      const { embeddings } = await this.modelsService.getEmbeddingsImages(payload)

      // Store PhotoImage and embedding for later save
      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const validImage = validImages.find((vi) => vi.photo.id === Number(item.id))
        if (validImage) {
          this.data[key] = { pi: validImage.photo, embedding: item.embedding }
        }
      })

      // Commit batch
      const photosToCommit = validImages.map((vi) => vi.photo)
      await this.commit(photosToCommit)
    }
  }

  async commit(batch: Photo[]): Promise<void> {
    const batchIds = batch.map((photo) => photo.id.toString())
    const batchData = batchIds.map((id) => this.data[id]).filter(Boolean)

    await Promise.all(
      batchData.map(({ pi, embedding }) => {
        const photo = pi
        photo.embedding = embedding
        return photo.save()
      })
    )

    const photoIds = batch.map((photo) => photo.id)
    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)
    logger.debug(`Guardadas embeddings para ${photoIds.length} imágenes`)

    // Limpiar los datos del batch después del commit
    batchIds.forEach((id) => delete this.data[id])
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
