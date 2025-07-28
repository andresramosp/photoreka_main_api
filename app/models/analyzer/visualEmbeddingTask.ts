import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualEmbeddingTask')
logger.setLevel(LogLevel.DEBUG)

type EmbeddingResponse = {
  id: string
  embedding: number[]
}

export class VisualEmbeddingTask extends AnalyzerTask {
  // Map photoId to its PhotoImage instance and embedding array
  declare data: Record<string, { pi: PhotoImage; embedding: number[] }>

  async process(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    const batchSize = 12

    let photosToProcess = pendingPhotos
    if (this.onlyIfNeeded) {
      photosToProcess = pendingPhotos.filter((pi) => pi.photo.embedding == null)
    }

    for (let i = 0; i < photosToProcess.length; i += batchSize) {
      await this.sleep(250)
      const batch = photosToProcess.slice(i, i + batchSize)
      const payload = batch.map((pi) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { embeddings } = await this.modelsService.getEmbeddingsImages(payload)

      // Store PhotoImage and embedding for later save
      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const pi = batch.find((p) => p.photo.id === Number(item.id))
        if (pi) {
          this.data[key] = { pi, embedding: item.embedding }
        }
      })
    }
  }

  async commit(): Promise<void> {
    const photoIds = Object.keys(this.data).map(Number)

    await Promise.all(
      Object.values(this.data).map(({ pi, embedding }) => {
        const photo = pi.photo
        photo.embedding = embedding
        return photo.save()
      })
    )

    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)
    logger.debug(`Guardadas embeddings para ${photoIds.length} imágenes`)
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
