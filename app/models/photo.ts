import { DateTime } from 'luxon'
import { BaseModel, beforeSave, belongsTo, column, computed, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import TagPhoto from './tag_photo.js'
import DescriptionChunk from './descriptionChunk.js'
import AnalyzerProcess from './analyzer/analyzerProcess.js'
import DetectionPhoto from './detection_photo.js'

export type DescriptionType = 'context' | 'story' | 'visual_accents' | 'artistic'
export type PhotoDescriptions = Record<DescriptionType, string>

export default class Photo extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare descriptions: PhotoDescriptions | null

  @column()
  declare title: string | null

  @column()
  declare model: string | null

  @column()
  declare name: string

  @column()
  declare url: string

  @column({ serializeAs: null })
  declare embedding: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => TagPhoto, {
    foreignKey: 'photoId',
  })
  declare tags: HasMany<typeof TagPhoto>

  @hasMany(() => DescriptionChunk, {
    foreignKey: 'photoId',
  })
  declare descriptionChunks: HasMany<typeof DescriptionChunk>

  @hasMany(() => DetectionPhoto, {
    foreignKey: 'photoId',
  })
  declare detections: HasMany<typeof DetectionPhoto>

  @column()
  declare analyzerProcessId: string // Clave foránea que conecta con AnalyzerProcess

  @belongsTo(() => AnalyzerProcess)
  declare analyzerProcess: BelongsTo<typeof AnalyzerProcess>

  @computed()
  public get needProcess(): boolean {
    return this.analyzerProcess?.currentStage !== 'finished'
  }

  @beforeSave()
  public static formatEmbedding(photo: Photo) {
    if (photo.embedding && Array.isArray(photo.embedding)) {
      // Convierte el array en formato pgvector: '[value1,value2,...]'
      photo.embedding = `[${(photo.embedding as any[]).join(',')}]`
    }
  }

  @computed()
  public get detectionAreas(): DetectionPhoto[] {
    return this.detections
    return this.detections.filter((det) => {
      const detArea = (det.x2 - det.x1) * (det.y2 - det.y1)
      if (detArea <= 0) return true // Área inválida, se mantiene o se ignora según necesidad
      // Se buscan áreas mayores que puedan cubrir esta detección
      for (const other of this.detections) {
        if (other.id === det.id) continue
        const otherArea = (other.x2 - other.x1) * (other.y2 - other.y1)
        if (otherArea <= detArea) continue
        const interWidth = Math.max(0, Math.min(det.x2, other.x2) - Math.max(det.x1, other.x1))
        const interHeight = Math.max(0, Math.min(det.y2, other.y2) - Math.max(det.y1, other.y1))
        const interArea = interWidth * interHeight
        // Si el área de intersección es mayor al 90% del área de la detección, se descarta
        if (interArea / detArea > 0.8) return false
      }
      return true
    })
  }

  @computed()
  public get parsedEmbedding(): number[] {
    return JSON.parse(this.embedding)
  }
}
