import { AnalyzerTask } from './analyzerTask.js'
import PhotoManager from '../../managers/photo_manager.js'
import DetectionPhoto from '#models/detection_photo'
import AnalyzerProcess from './analyzerProcess.js'
import PhotoImage from './photoImage.js'
import PhotoImageService from '../../services/photo_image_service.js'
import ModelsService from '../../services/models_service.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'

const logger = Logger.getInstance('AnalyzerProcess', 'VisualDetectionTask')
logger.setLevel(LogLevel.DEBUG)

interface DetectionResponse {
  id: string
  detections: Record<string, number[][]>
}

export class VisualDetectionTask extends AnalyzerTask {
  declare categories: string[]
  declare minBoxSize: number
  declare data: Record<string, Record<string, number[][]>> // foto -> { object_detected -> box }

  private photoImageService: PhotoImageService
  private modelsService: ModelsService

  constructor() {
    super()
    this.photoImageService = PhotoImageService.getInstance()
    this.modelsService = new ModelsService()
  }

  async prepare(process: AnalyzerProcess): Promise<void> {
    // No se necesita preparación específica para VisualDetectionTask
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
    if (!this.data) {
      this.data = {}
    }

    const batchSize = 10
    for (let i = 0; i < pendingPhotos.length; i += batchSize) {
      await this.sleep(250)
      const batch = pendingPhotos.slice(i, i + batchSize)
      const payload = batch.map((pi: PhotoImage) => ({ id: pi.photo.id, base64: pi.base64 }))
      const { detections: result } = await this.modelsService.getObjectsDetections(
        payload,
        this.categories
      )
      result.forEach((res: DetectionResponse) => {
        const { id: photoId, detections } = res
        this.data[photoId] = { ...detections }
      })

      await this.commit()
      logger.debug(`Completada detección para ${batch.length} imágenes`)
    }
  }

  async commit(): Promise<void> {
    const photoManager = new PhotoManager()

    await Promise.all(
      Object.entries(this.data).map(([photoId, detections]) => {
        const detectionsPhotos: Partial<DetectionPhoto>[] = []

        for (const [category, boxes] of Object.entries(detections)) {
          for (const box of boxes) {
            if (box.length !== 4) continue
            const [x1, y1, x2, y2] = box
            detectionsPhotos.push({
              category,
              x1,
              y1,
              x2,
              y2,
            })
          }
        }

        return photoManager.updatePhotoDetections(photoId, detectionsPhotos)
      })
    )
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
