import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import Logger, { LogLevel } from '../../utils/logger.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualColorEmbeddingTask')
logger.setLevel(LogLevel.DEBUG)

type EmbeddingResponse = {
  id: string
  embedding_full: number[]
  embedding_dominant: number[]
}

export class VisualColorEmbeddingTask extends AnalyzerTask {
  // Map photoId to its PhotoImage instance and embedding array
  declare data: Record<
    string,
    { pi: PhotoImage; embedding_full: number[]; embedding_dominant: number[] }
  >

  async process(pendingPhotos: PhotoImage[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    for (let i = 0; i < pendingPhotos.length; i += 64) {
      await this.sleep(250)
      const batch = pendingPhotos.slice(i, i + 64)
      const payload = batch.map((pi) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { embeddings } = await this.modelsService.getHistogramColor(payload)

      // Store PhotoImage and embedding for later save
      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const pi = batch.find((p) => p.photo.id === Number(item.id))
        if (pi) {
          this.data[key] = {
            pi,
            embedding_full: item.embedding_full,
            embedding_dominant: item.embedding_dominant,
          }
        }
      })
    }
  }

  async commit(): Promise<void> {
    const photoIds = Object.keys(this.data).map(Number)

    await Promise.all(
      Object.values(this.data).map(({ pi, embedding_full, embedding_dominant }) => {
        const photo = pi.photo
        photo.colorHistogram = embedding_full
        photo.colorHistogramDominant = embedding_dominant
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
