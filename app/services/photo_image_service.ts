import sharp from 'sharp'
import Logger, { LogLevel } from '../utils/logger.js'

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { withCache } from '../decorators/withCache.js'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})

const logger = Logger.getInstance('PhotoImageService')
logger.setLevel(LogLevel.DEBUG)

export default class PhotoImageService {
  private static instance: PhotoImageService

  private constructor() {}

  public static getInstance(): PhotoImageService {
    if (!PhotoImageService.instance) {
      PhotoImageService.instance = new PhotoImageService()
    }
    return PhotoImageService.instance
  }

  @withCache({ provider: 'redis', ttl: 60 * 5 })
  public async getImageBase64FromR2(
    filename: string,
    withGuideLines: boolean = false
  ): Promise<String> {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: filename,
    })

    const s3Response = await s3.send(command)

    if (!s3Response.Body) {
      throw new Error(`No se encontró el archivo ${filename} en R2`)
    }

    const chunks: Buffer[] = []
    for await (const chunk of s3Response.Body as Readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    const buffer = Buffer.concat(chunks)

    // Si no se necesitan líneas guía, devolver el buffer original
    if (!withGuideLines) {
      return buffer.toString('base64')
    }

    // Procesar imagen con líneas guía
    const resizedBuffer = await sharp(buffer).resize({ width: 1200, fit: 'inside' }).toBuffer()

    const resizedImage = sharp(resizedBuffer)
    const metadata = await resizedImage.metadata()
    const width = metadata.width || 0
    const height = metadata.height || 0
    const lineThickness = 5
    const leftLineX = Math.floor(0.375 * width)
    const rightLineX = Math.floor(0.625 * width)

    const svgOverlay = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${leftLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
      <rect x="${rightLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
    </svg>`

    const imageWithGuideBuffer = await resizedImage
      .composite([{ input: Buffer.from(svgOverlay) }])
      .toBuffer()

    return imageWithGuideBuffer.toString('base64')
  }

  // public async getPhotoImages(
  //   process: AnalyzerProcess,
  //   useGuides: boolean = false
  // ): Promise<PhotoImage[]> {
  //   // if (process.mode == 'retry_process') {
  //   //   this.clearCache(process.id)
  //   // }
  //   const cacheKey = `${process.id}_${useGuides}`

  //   if (!this.imageCache.has(cacheKey)) {
  //     logger.debug(`Cargando imágenes para proceso ${process.id}`)
  //     await this.populatePhotoImages(process)
  //     this.imageCache.set(cacheKey, useGuides ? this.photoImagesWithGuides : this.photoImages)
  //   }

  //   return this.imageCache.get(cacheKey)!
  // }

  // public clearCache(processId: string) {
  //   logger.debug(`Limpiando caché para proceso ${processId}`)
  //   for (const key of this.imageCache.keys()) {
  //     if (key.startsWith(processId)) {
  //       this.imageCache.delete(key)
  //     }
  //   }
  // }

  // public async populatePhotoImages(process: AnalyzerProcess) {
  //   const localUploadPath = getLocalUploadPath()
  //   const withGuidesPath = path.join(localUploadPath, 'withGuides')
  //   await fs.mkdir(withGuidesPath, { recursive: true })

  //   // Imágenes originales desde R2
  //   const processes = await Promise.all(
  //     process.photos.map((photo) =>
  //       limit(async () => {
  //         try {
  //           const buffer = await this.getImageBase64FromR2(photo.name, false)
  //           // Obtener tamaño en MB
  //           // Obtener dimensiones con sharp
  //           let width = 0,
  //             height = 0
  //           try {
  //             const metadata = await sharp(buffer).metadata()
  //             width = metadata.width || 0
  //             height = metadata.height || 0
  //           } catch (err) {
  //             logger.warn(`No se pudo obtener metadata de la imagen ${photo.name}`, err)
  //           }
  //           // logger.info(
  //           //   `Imagen ${photo.name}: tamaño ${sizeMB} MB, dimensiones ${width}x${height} px`
  //           // )
  //           const base64Image = buffer.toString('base64')
  //           const pp = new PhotoImage()
  //           pp.photo = photo
  //           pp.base64 = base64Image
  //           return pp
  //         } catch (error) {
  //           console.warn(`No se pudo obtener la imagen ${photo.name} desde R2`, error)
  //           throw error // Re-throw to handle it in the calling function
  //         }
  //       })
  //     )
  //   )
  //   this.photoImages = processes.filter((pp) => pp !== null) as PhotoImage[]

  //   // Imágenes con guías: leer desde R2, procesar en memoria, opcionalmente guardar en local
  //   const processesWithGuides = await Promise.all(
  //     process.photos.map((photo) =>
  //       limit(async () => {
  //         try {
  //           const buffer = await this.getImageBase64FromR2(photo.name, true)
  //           const resizedBuffer = await sharp(buffer)
  //             .resize({ width: 1200, fit: 'inside' })
  //             .toBuffer()
  //           const resizedImage = sharp(resizedBuffer)
  //           const metadata = await resizedImage.metadata()
  //           const width = metadata.width || 0
  //           const height = metadata.height || 0
  //           const lineThickness = 5
  //           const leftLineX = Math.floor(0.375 * width)
  //           const rightLineX = Math.floor(0.625 * width)
  //           const svgOverlay = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  //             <rect x="${leftLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
  //             <rect x="${rightLineX}" y="0" width="${lineThickness}" height="${height}" fill="white"/>
  //           </svg>`
  //           const imageWithGuideBuffer = await resizedImage
  //             .composite([{ input: Buffer.from(svgOverlay) }])
  //             .toBuffer()

  //           const base64ImageWithGuide = imageWithGuideBuffer.toString('base64')
  //           const ppGuide = new PhotoImage()
  //           ppGuide.photo = photo
  //           ppGuide.base64 = base64ImageWithGuide
  //           return ppGuide
  //         } catch (error) {
  //           console.warn(`No se pudo procesar la imagen con guía ${photo.name}`, error)
  //           throw error // Re-throw to handle it in the calling function
  //         }
  //       })
  //     )
  //   )

  //   this.photoImagesWithGuides = processesWithGuides.filter((pp) => pp !== null) as PhotoImage[]
  // }
}
