import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'
import PhotoImageService from '#services/photo_image_service'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualColorEmbeddingTask')
logger.setLevel(LogLevel.DEBUG)

type EmbeddingResponse = {
  id: string
  embedding_full: number[]
  embedding_dominant: number[]
}

export class VisualColorEmbeddingTask extends AnalyzerTask {
  declare data: Record<
    string,
    { pi: Photo; embedding_full: number[]; embedding_dominant: number[] }
  >

  async process(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }
    const photoImageService = PhotoImageService.getInstance()
    for (let i = 0; i < pendingPhotos.length; i += 64) {
      await this.sleep(250)
      const batch = pendingPhotos.slice(i, i + 64)
      const payload = await Promise.all(
        batch.map(async (pi) => ({
          id: pi.id,
          base64: await photoImageService.getImageBase64FromR2(pi.name, false),
        }))
      )
      const { embeddings } = await this.modelsService.getHistogramColor(payload)

      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const pi = batch.find((p) => p.id === Number(item.id))
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
        const photo = pi
        photo.colorHistogram = embedding_full
        photo.colorHistogramDominant = embedding_dominant
        return photo.save()
      })
    )

    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)

    // Limpiar data para liberar memoria
    for (const key of Object.keys(this.data)) {
      delete this.data[key]
    }

    logger.debug(`Guardadas embeddings para ${photoIds.length} imágenes`)
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
