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
      const payload = await Promise.all(
        batch.map(async (pi) => ({
          id: pi.id,
          base64: await photoImageService.getImageBase64FromR2(pi.name, false),
        }))
      )
      const { embeddings } = await this.modelsService.getEmbeddingsImages(payload)

      // Store PhotoImage and embedding for later save
      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const pi = batch.find((p) => p.id === Number(item.id))
        if (pi) {
          this.data[key] = { pi, embedding: item.embedding }
        }
      })

      await this.commit(batch)
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
