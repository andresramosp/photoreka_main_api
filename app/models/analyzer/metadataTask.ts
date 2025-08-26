import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'
import PhotoManager from '../../managers/photo_manager.js'
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'

const logger = Logger.getInstance('AnalyzerProcess', 'MetadataTask')
logger.setLevel(LogLevel.DEBUG)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})

interface PhotoMetadata {
  orientation: string[]
  temperature?: string[]
  palette?: string[]
  width?: number
  height?: number
  fileSize?: number
  format?: string
  exif?: any
}

export class MetadataTask extends AnalyzerTask {
  declare data: Record<number, PhotoMetadata>

  async process(pendingPhotos: Photo[]): Promise<void> {
    if (!this.data) {
      this.data = {}
    }

    // Si onlyIfNeeded es true, filtrar fotos que ya tienen orientation
    let photosToProcess = pendingPhotos
    if (this.onlyIfNeeded) {
      const HealthPhotoService = (await import('../../services/health_photo_service.js')).default
      const photosWithoutOrientation = []

      for (const photo of pendingPhotos) {
        const health = await HealthPhotoService.photoHealth(photo.id)
        const hasOrientation =
          health.checks.find((c) => c.label === 'descriptions.visual_aspects.orientation')?.ok ||
          false

        if (!hasOrientation) {
          photosWithoutOrientation.push(photo)
        }
      }

      photosToProcess = photosWithoutOrientation
      logger.debug(
        `onlyIfNeeded=true: procesando ${photosToProcess.length}/${pendingPhotos.length} fotos`
      )
    }

    logger.debug(`Procesando metadatos para ${photosToProcess.length} fotos`)

    // Procesar fotos en lotes de 5 en paralelo para optimizar I/O
    const BATCH_SIZE = 5
    const batches = []

    for (let i = 0; i < photosToProcess.length; i += BATCH_SIZE) {
      batches.push(photosToProcess.slice(i, i + BATCH_SIZE))
    }

    for (const batch of batches) {
      try {
        // Procesar el lote en paralelo
        const results = await Promise.allSettled(
          batch.map(async (photo) => {
            try {
              const metadata = await this.extractPhotoMetadata(photo)
              this.data[photo.id] = metadata
              return { photo, success: true }
            } catch (error) {
              logger.error(
                `Error procesando metadatos para foto ${photo.id} (${photo.name}):`,
                error
              )
              return { photo, success: false, error }
            }
          })
        )

        // Filtrar solo las fotos procesadas exitosamente para el commit
        const successfulPhotos = results
          .filter((result) => result.status === 'fulfilled' && result.value.success)
          .map((result) => (result as PromiseFulfilledResult<any>).value.photo)

        if (successfulPhotos.length > 0) {
          // Commit del lote completo para liberar memoria progresivamente
          await this.commit(successfulPhotos)
        }

        logger.debug(`Lote procesado: ${successfulPhotos.length}/${batch.length} fotos exitosas`)
      } catch (error) {
        logger.error(`Error procesando lote de ${batch.length} fotos:`, error)
        // Continuar con el siguiente lote en caso de error
      }
    }
  }

  private async extractPhotoMetadata(photo: Photo): Promise<PhotoMetadata> {
    try {
      // Obtener información básica del archivo desde S3
      const headCommand = new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: photo.name,
      })

      const s3Head = await s3.send(headCommand)
      const fileSize = s3Head.ContentLength || 0

      // Obtener el buffer de la imagen para analizar metadatos
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: photo.name,
      })

      const s3Response = await s3.send(command)

      if (!s3Response.Body) {
        throw new Error(`No se encontró el archivo ${photo.name} en R2`)
      }

      // Convertir stream a buffer de forma eficiente
      const chunks: Buffer[] = []
      for await (const chunk of s3Response.Body as any) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const buffer = Buffer.concat(chunks)

      // Usar sharp para obtener metadatos de la imagen
      const sharpMetadata = await sharp(buffer).metadata()

      // Obtener estadísticas de color para calcular temperature y detectar color/B&W
      const imageStats = await sharp(buffer).stats()

      // Calcular temperature basada en los canales RGB promedio
      const rAvg = imageStats.channels[0].mean
      const bAvg = imageStats.channels[2].mean

      let temperature: string
      const warmCoolDiff = rAvg - bAvg
      const threshold = 10 // Umbral para considerar neutral

      if (warmCoolDiff > threshold) {
        temperature = 'warm'
      } else if (warmCoolDiff < -threshold) {
        temperature = 'cold'
      } else {
        temperature = 'neutral'
      }

      // Detectar si es color o blanco y negro
      const paletteType = await this.detectImagePalette(buffer)

      // Determinar orientación basada en dimensiones
      const width = sharpMetadata.width || 0
      const height = sharpMetadata.height || 0
      let orientation: string

      if (width > height) {
        orientation = 'horizontal'
      } else if (height > width) {
        orientation = 'vertical'
      } else {
        orientation = 'square'
      }

      // Limpiar buffer para liberar memoria
      chunks.length = 0

      return {
        orientation: [orientation],
        temperature: [temperature],
        palette: [paletteType],
        width,
        height,
        fileSize,
        format: sharpMetadata.format,
        exif: sharpMetadata.exif ? this.parseExifData(sharpMetadata.exif) : null,
      }
    } catch (error) {
      logger.error(`Error extrayendo metadatos para ${photo.name}:`, error)
      // Retornar datos mínimos en caso de error
      return {
        orientation: ['unknown'],
        temperature: ['neutral'],
        palette: ['color'], // Asumir color por defecto en caso de error
      }
    }
  }

  private async detectImagePalette(buffer: Buffer): Promise<string> {
    try {
      // Obtener información básica de la imagen
      const metadata = await sharp(buffer).metadata()

      // Si la imagen tiene solo 1 canal, es definitivamente B&W
      if (metadata.channels && metadata.channels <= 1) {
        return 'black and white'
      }

      // Para imágenes RGB, usar el método TomB (análisis píxel por píxel)
      if (metadata.channels && metadata.channels >= 3) {
        // Redimensionar imagen para optimizar procesamiento (manteniendo aspect ratio)
        const resized = await sharp(buffer)
          .resize(100, 100, { fit: 'inside' })
          .raw()
          .toBuffer({ resolveWithObject: true })
        const { data, info } = resized

        let totalDiff = 0
        const pixels = info.width * info.height

        // Para cada píxel, calcular diferencias absolutas entre canales R-G, R-B, G-B
        for (let i = 0; i < data.length; i += 3) {
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]

          const rg = Math.abs(r - g)
          const rb = Math.abs(r - b)
          const gb = Math.abs(g - b)

          totalDiff += rg + rb + gb
        }

        // Normalizar por número de píxeles y rango máximo (255 * 3)
        const colorFactor = totalDiff / (pixels * 255 * 3)

        // Umbrales ajustables para determinismo
        const COLOR_THRESHOLD_HIGH = 0.08 // 8% - claramente color
        const COLOR_THRESHOLD_LOW = 0.02 // 2% - claramente B&W

        if (colorFactor >= COLOR_THRESHOLD_HIGH) {
          return 'color'
        } else if (colorFactor <= COLOR_THRESHOLD_LOW) {
          return 'black and white'
        } else {
          // Zona gris: aplicar segundo criterio basado en saturación
          return await this.detectColorBySaturation(buffer)
        }
      }

      // Fallback
      return 'color'
    } catch (error) {
      logger.error('Error detectando palette de imagen:', error)
      return 'color' // Asumir color por defecto en caso de error
    }
  }

  private async detectColorBySaturation(buffer: Buffer): Promise<string> {
    try {
      // Convertir a HSV para analizar saturación
      const { data, info } = await sharp(buffer)
        .resize(50, 50, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true })

      let totalSaturation = 0
      const pixels = info.width * info.height

      // Convertir RGB a HSV y analizar saturación
      for (let i = 0; i < data.length; i += 3) {
        const r = data[i] / 255
        const g = data[i + 1] / 255
        const b = data[i + 2] / 255

        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const saturation = max === 0 ? 0 : (max - min) / max

        totalSaturation += saturation
      }

      const avgSaturation = totalSaturation / pixels
      const SATURATION_THRESHOLD = 0.05 // 5% de saturación promedio

      return avgSaturation > SATURATION_THRESHOLD ? 'color' : 'black and white'
    } catch (error) {
      logger.error('Error analizando saturación:', error)
      return 'color'
    }
  }

  private parseExifData(exifBuffer: Buffer): any {
    try {
      // Parseo básico de EXIF - se puede expandir según necesidades
      return {
        // Por ahora solo guardamos que existe EXIF
        hasExif: true,
        size: exifBuffer.length,
      }
    } catch (error) {
      logger.error('Error parseando datos EXIF:', error)
      return null
    }
  }

  async commit(batch: Photo[]): Promise<void> {
    try {
      const photoManager = new PhotoManager()
      const photoIds = batch.map((p) => p.id)

      await Promise.all(
        photoIds.map((photoId: number) => {
          const metadata = this.data[photoId]
          if (!metadata) return Promise.resolve(null)

          // Estructurar los datos como visual_aspects siguiendo el patrón de visionDescriptionTask
          const visualAspectsData = {
            orientation: metadata.orientation,
            ...(metadata.temperature && { temperature: metadata.temperature }),
            ...(metadata.palette && { palette: metadata.palette }),
            // Se pueden agregar más campos aquí en el futuro
            ...(metadata.width &&
              metadata.height && {
                dimensions: [`${metadata.width}x${metadata.height}`],
              }),
            ...(metadata.format && {
              format: [metadata.format],
            }),
          }

          // El PhotoManager ahora se encarga del merge automáticamente
          const descriptions = { visual_aspects: visualAspectsData } as any
          return photoManager.updatePhotoDescriptions(photoId.toString(), descriptions)
        })
      )

      // Marcar fotos como completadas
      const photoIdsArray = batch.map((photo) => photo.id)
      await this.analyzerProcess.markPhotosCompleted(this.name, photoIdsArray)

      // Limpiar los datos del batch después del commit
      photoIds.forEach((id) => delete this.data[id])

      logger.debug(`Guardados metadatos para ${photoIds.length} fotos`)
    } catch (err) {
      logger.error(`Error guardando metadatos:`, err)
    }
  }
}
