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
  declare thumbnailName: string

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
    const threshold = 0.5
    // Filtrar detecciones con área válida
    if (!this.detections) {
      return []
    }
    let detections = [...this.detections]
      .filter((det) =>
        ['animal', 'person', 'prominent object', 'architectural feature'].includes(det.category)
      )
      .filter((det) => {
        const area = (det.x2 - det.x1) * (det.y2 - det.y1)
        return area > 0
      })

    // Ordenar detecciones por área de mayor a menor
    detections.sort((a, b) => {
      const areaA = (a.x2 - a.x1) * (a.y2 - a.y1)
      const areaB = (b.x2 - b.x1) * (b.y2 - b.y1)
      return areaB - areaA
    })

    const finalDetections: DetectionPhoto[] = []
    while (detections.length) {
      const current = detections.shift()!
      finalDetections.push(current)
      detections = detections.filter((det) => {
        const areaCurrent = (current.x2 - current.x1) * (current.y2 - current.y1)
        const areaDet = (det.x2 - det.x1) * (det.y2 - det.y1)
        const interWidth = Math.max(0, Math.min(current.x2, det.x2) - Math.max(current.x1, det.x1))
        const interHeight = Math.max(0, Math.min(current.y2, det.y2) - Math.max(current.y1, det.y1))
        const interArea = interWidth * interHeight
        const union = areaCurrent + areaDet - interArea
        const iou = interArea / union
        return iou < threshold
      })
    }

    return finalDetections
  }

  @computed()
  public get parsedEmbedding(): number[] | null {
    return this.embedding ? JSON.parse(this.embedding) : null
  }

  @computed()
  public get thumbnailUrl(): string {
    return `/uploads/${this.thumbnailName}`
  }

  @computed()
  public get originalUrl(): string {
    return `/uploads/${this.name}`
  }

  @computed()
  public get tempID(): string {
    return Math.random().toString(36).substr(2, 4)
  }
}
