import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Photo from '../photo.js'
import PhotoProcess from './photoProcess.js'
import path from 'path'
import fs from 'fs/promises'
import sharp from 'sharp'
import { AnalyzerTask } from './analyzerTask.js'

export type ModelType = 'GPT' | 'Molmo'
export type StageType =
  | 'init'
  | 'vision_tasks'
  | 'tags_tasks'
  | 'embeddings_tags'
  | 'chunks_tasks'
  | 'embeddings_chunks'
  | 'finished'

export default class AnalyzerProcess extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

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

  public photoImages: PhotoProcess[] = []

  public async populatePhotoImages() {
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')
    const processes = await Promise.all(
      this.photos.map(async (photo) => {
        const filePath = path.join(uploadPath, photo.name)
        try {
          await fs.access(filePath)
          const resizedBuffer = await sharp(filePath).toBuffer()
          const base64Image = resizedBuffer.toString('base64')
          const pp = new PhotoProcess()
          pp.photoId = photo.id
          pp.base64 = base64Image
          // // Si la foto ya fue procesada, se agregan más datos
          // if (photo.processed?.context && photo.processed?.story) {
          //   pp.data = {
          //     context: photo.descriptions?.context,
          //     story: photo.descriptions?.story,
          //     processed: photo.processed,
          //   }
          // } else {
          //   pp.data = {}
          // }
          return pp
        } catch (error) {
          console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
          return null
        }
      })
    )
    // Filtrar instancias nulas
    this.photoImages = processes.filter((pp) => pp !== null) as PhotoProcess[]
  }
}
