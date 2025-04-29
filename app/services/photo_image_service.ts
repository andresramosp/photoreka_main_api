import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import PhotoImage from '#models/analyzer/photoImage'
import sharp from 'sharp'
import { getUploadPath } from '../utils/dataPath.js'
import Logger, { LogLevel } from '../utils/logger.js'
import path from 'path'
import fs from 'fs/promises'

const logger = Logger.getInstance('PhotoImageService')
logger.setLevel(LogLevel.DEBUG)

export default class PhotoImageService {
  private static instance: PhotoImageService
  private imageCache: Map<string, PhotoImage[]> = new Map()

  public photoImages: PhotoImage[] = []
  public photoImagesWithGuides: PhotoImage[] = []

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
    if (process.mode == 'retry') {
      this.clearCache(process.id)
    }
    const cacheKey = `${process.id}_${useGuides}`

    if (!this.imageCache.has(cacheKey)) {
      logger.debug(`Cargando imágenes para proceso ${process.id} (guías: ${useGuides})`)
      await this.populatePhotoImages(process)
      this.imageCache.set(cacheKey, useGuides ? this.photoImagesWithGuides : this.photoImages)
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

  public async populatePhotoImages(process: AnalyzerProcess) {
    const uploadPath = getUploadPath()
    const withGuidesPath = path.join(uploadPath, 'withGuides')
    await fs.mkdir(withGuidesPath, { recursive: true })

    // Procesamiento de imágenes originales
    const processes = await Promise.all(
      process.photos.map(async (photo) => {
        const filePath = path.join(uploadPath, photo.name)
        try {
          await fs.access(filePath)
          const resizedBuffer = await sharp(filePath).toBuffer()
          const base64Image = resizedBuffer.toString('base64')
          const pp = new PhotoImage()
          pp.photo = photo
          pp.base64 = base64Image
          return pp
        } catch (error) {
          console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
          return null
        }
      })
    )
    this.photoImages = processes.filter((pp) => pp !== null) as PhotoImage[]

    // Procesamiento de imágenes con guías (líneas verticales)
    const processesWithGuides = await Promise.all(
      process.photos.map(async (photo) => {
        const filePath = path.join(uploadPath, photo.name)
        try {
          await fs.access(filePath)
          // Redimensionar y obtener el buffer redimensionado
          const resizedBuffer = await sharp(filePath)
            .resize({ width: 1200, fit: 'inside' })
            .toBuffer()
          // Crear instancia a partir del buffer redimensionado para obtener dimensiones reales
          const resizedImage = sharp(resizedBuffer)
          const metadata = await resizedImage.metadata()
          const width = metadata.width || 0
          const height = metadata.height || 0
          const lineThickness = 5 // Grosor de la línea en píxeles
          const leftLineX = Math.floor(0.375 * width)
          const rightLineX = Math.floor(0.625 * width)
          // Crear overlay SVG con dos líneas verticales
          const svgOverlay = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            <rect x="${leftLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
            <rect x="${rightLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
          </svg>`
          const imageWithGuideBuffer = await resizedImage
            .composite([{ input: Buffer.from(svgOverlay) }])
            .toBuffer()
          // Guardar la imagen modificada para debuguear
          const outputFilePath = path.join(withGuidesPath, photo.name)
          await fs.writeFile(outputFilePath, imageWithGuideBuffer)
          const base64ImageWithGuide = imageWithGuideBuffer.toString('base64')
          const ppGuide = new PhotoImage()
          ppGuide.photo = photo
          ppGuide.base64 = base64ImageWithGuide
          return ppGuide
        } catch (error) {
          console.warn(
            `No se pudo procesar la imagen con guía para la imagen con ID: ${photo.id}`,
            error
          )
          return null
        }
      })
    )
    this.photoImagesWithGuides = processesWithGuides.filter((pp) => pp !== null) as PhotoImage[]
  }
}
