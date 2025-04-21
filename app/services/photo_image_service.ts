import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import PhotoImage from '#models/analyzer/photoImage'
import Logger, { LogLevel } from '../utils/logger.js'

const logger = Logger.getInstance('PhotoImageService')
logger.setLevel(LogLevel.DEBUG)

export default class PhotoImageService {
  private static instance: PhotoImageService
  private imageCache: Map<string, PhotoImage[]> = new Map()

  private constructor() {}

  public static getInstance(): PhotoImageService {
    if (!PhotoImageService.instance) {
      PhotoImageService.instance = new PhotoImageService()
    }
    return PhotoImageService.instance
  }

  public async getPhotoImages(
    process: AnalyzerProcess,
    useGuides: boolean = false
  ): Promise<PhotoImage[]> {
    const cacheKey = `${process.id}_${useGuides}`

    if (!this.imageCache.has(cacheKey)) {
      logger.debug(`Cargando imágenes para proceso ${process.id} (guías: ${useGuides})`)
      await process.populatePhotoImages()
      this.imageCache.set(cacheKey, useGuides ? process.photoImagesWithGuides : process.photoImages)
    }

    return this.imageCache.get(cacheKey)!
  }

  public clearCache(processId: string) {
    logger.debug(`Limpiando caché para proceso ${processId}`)
    for (const key of this.imageCache.keys()) {
      if (key.startsWith(processId)) {
        this.imageCache.delete(key)
      }
    }
  }
}
