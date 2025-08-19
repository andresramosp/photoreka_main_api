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
      const { embeddings } = await this.modelsService.getHistogramColor(payload)

      embeddings.forEach((item: EmbeddingResponse) => {
        const key = item.id
        const validImage = validImages.find((vi) => vi.photo.id === Number(item.id))
        if (validImage) {
          this.data[key] = {
            pi: validImage.photo,
            embedding_full: item.embedding_full,
            embedding_dominant: item.embedding_dominant,
          }
        }
      })

      // Commit solo de las fotos válidas procesadas
      const photosToCommit = validImages.map((vi) => vi.photo)
      await this.commit(photosToCommit)
    }
  }

  async commit(batch: Photo[]): Promise<void> {
    const batchIds = batch.map((photo) => photo.id.toString())
    const batchData = batchIds.map((id) => this.data[id]).filter(Boolean)

    await Promise.all(
      batchData.map(({ pi, embedding_full, embedding_dominant }) => {
        const photo = pi
        photo.colorHistogram = embedding_full
        photo.colorHistogramDominant = embedding_dominant
        return photo.save()
      })
    )

    const photoIds = batch.map((photo) => photo.id)
    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)

    // Limpiar los datos del batch después del commit
    batchIds.forEach((id) => delete this.data[id])

    logger.debug(`Guardadas embeddings para ${photoIds.length} imágenes`)
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
