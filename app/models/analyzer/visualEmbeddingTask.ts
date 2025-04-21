import { AnalyzerTask } from './analyzerTask.js'
import AnalyzerProcess from './analyzerProcess.js'
import PhotoImage from './photoImage.js'
import PhotoImageService from '../../services/photo_image_service.js'
import ModelsService from '../../services/models_service.js'
import Logger, { LogLevel } from '../../utils/logger.js'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualEmbeddingTask')
logger.setLevel(LogLevel.DEBUG)

type EmbeddingResponse = {
  id: string
  embedding: number[]
}

export class VisualEmbeddingTask extends AnalyzerTask {
  private photoImageService: PhotoImageService
  private modelsService: ModelsService

  constructor() {
    super()
    this.photoImageService = PhotoImageService.getInstance()
    this.modelsService = new ModelsService()
  }

  async prepare(process: AnalyzerProcess): Promise<void> {
    // No se necesita preparación específica para VisualEmbeddingTask
  }

  async getPendingPhotos(process: AnalyzerProcess): Promise<PhotoImage[]> {
    if (process.mode === 'retry') {
      const failedPhotos = Object.entries(process.failed)
        .filter(([_, taskName]) => taskName === this.name)
        .map(([photoId]) => photoId)

      const allImages = await this.photoImageService.getPhotoImages(process)
      return allImages.filter((img) => failedPhotos.includes(img.photo.id))
    }

    return await this.photoImageService.getPhotoImages(process)
  }

  async process(process: AnalyzerProcess, pendingPhotos: PhotoImage[]): Promise<void> {
    for (let i = 0; i < pendingPhotos.length; i += 16) {
      await this.sleep(250)
      const batch = pendingPhotos.slice(i, i + 16)
      const payload = batch.map((pi: PhotoImage) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { embeddings } = await this.modelsService.getEmbeddingsImages(payload)
      await Promise.all(
        batch.map((pi: PhotoImage, index) => {
          const photo = pi.photo
          const embedding = embeddings.find((item: EmbeddingResponse) => item.id === pi.photo.id)
          if (embedding) {
            photo.embedding = embedding.embedding
          }
          return photo.save()
        })
      )
    }
  }

  async commit(): Promise<void> {
    // No se necesita commit específico ya que los embeddings se guardan durante el process
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
