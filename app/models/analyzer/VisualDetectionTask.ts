import { AnalyzerTask } from './analyzerTask.js'
import PhotoManager from '../../managers/photo_manager.js'
import DetectionPhoto from '#models/detection_photo'

export class VisualDetectionTask extends AnalyzerTask {
  declare categories: string[]
  declare minBoxSize: number
  declare data: Record<string, Record<string, number[][]>> // foto -> { object_detected -> box }

  public async commit() {
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
}
