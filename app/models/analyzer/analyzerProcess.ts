import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Photo from '../photo.js'
import PhotoImage from './photoImage.js'
import path from 'path'
import fs from 'fs/promises'
import sharp from 'sharp'
import { AnalyzerTask } from './analyzerTask.js'
import { getUploadPath } from '../../utils/dataPath.js'
import { getTaskList } from '../../analyzer_packages.js'
import Logger, { LogLevel } from '../../utils/logger.js'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

export type AnalyzerMode = 'first' | 'adding' | 'remake' | 'retry'
export type ModelType = 'GPT' | 'Molmo'
export type StageType =
  | 'init'
  | 'vision_tasks'
  | 'tags_tasks'
  | 'embeddings_tags'
  | 'chunks_tasks'
  | 'embeddings_chunks'
  | 'finished'
export type FailedPhotos = Record<string, string | null>

export default class AnalyzerProcess extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare packageId: string

  @column()
  declare mode: AnalyzerMode

  @column()
  declare failed: FailedPhotos

  @column({
    serializeAs: 'tasks',
    prepare: (value: AnalyzerTask[] | null) =>
      value ? { tasks: value.map((task) => task.toJSON()) } : null,
  })
  declare tasks: AnalyzerTask[] | null

  @column()
  declare currentStage: StageType | null

  @column()
  declare userId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Photo, {
    foreignKey: 'analyzerProcessId',
  })
  declare photos: HasMany<typeof Photo>

  public photoImages: PhotoImage[] = []

  public photoImagesWithGuides: PhotoImage[] = []

  public async initialize(userPhotos: Photo[], packageId: string, mode: AnalyzerMode = 'first') {
    this.mode = mode
    this.packageId = packageId
    this.tasks = getTaskList(packageId)
    this.currentStage = 'init'
    await this.save()

    const photosToProcess = this.getInitialPhotos(userPhotos)
    await this.setProcessPhotos(photosToProcess)
    await this.populatePhotoImages()
  }

  private getInitialPhotos(userPhotos: Photo[]): Photo[] {
    switch (this.mode) {
      case 'adding':
        return userPhotos.filter((photo) => !photo.analyzerProcess)
      case 'first':
      case 'remake':
        return userPhotos
      case 'retry':
        return []
      default:
        throw new Error(`Modo de proceso no válido: ${this.mode}`)
    }
  }

  private async setProcessPhotos(photos: Photo[]) {
    const newPhotosIds = photos.map((p) => p.id)

    // Desasociar fotos que ya no están en el proceso
    await Photo.query()
      .where('analyzer_process_id', this.id)
      .whereNotIn('id', newPhotosIds)
      .update({ analyzer_process_id: null })

    // Asociar nuevas fotos al proceso
    await Photo.query().whereIn('id', newPhotosIds).update({ analyzer_process_id: this.id })

    // Recargar el proceso con las fotos preload
    const updatedProcess = await AnalyzerProcess.query()
      .where('id', this.id)
      .preload('photos')
      .firstOrFail()

    this.photos = updatedProcess.photos
    await this.save()
  }

  public async populatePhotoImages() {
    const uploadPath = getUploadPath()
    const withGuidesPath = path.join(uploadPath, 'withGuides')
    await fs.mkdir(withGuidesPath, { recursive: true })

    // Procesamiento de imágenes originales
    const processes = await Promise.all(
      this.photos.map(async (photo) => {
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
      this.photos.map(async (photo) => {
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

  public async addFailedPhotos(photoIds: string[], taskName: string): Promise<void> {
    logger.debug(`Añadiendo ${photoIds.length} fotos fallidas para tarea ${taskName}`)

    if (!this.failed) {
      this.failed = {}
    }
    photoIds.forEach((id) => {
      this.failed[id] = taskName
    })
    await this.save()
  }

  public async removeFailedPhotos(photoIds: string[], taskName: string): Promise<void> {
    logger.debug(`Eliminando ${photoIds.length} fotos fallidas para tarea ${taskName}`)

    if (!this.failed) return
    photoIds.forEach((id) => {
      if (this.failed[id] === taskName) {
        delete this.failed[id]
      }
    })
    await this.save()
  }
}
