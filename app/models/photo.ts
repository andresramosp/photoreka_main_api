import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column, computed, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import TagPhoto from './tag_photo.js'
import DescriptionChunk from './descriptionChunk.js'
import AnalyzerProcess from './analyzer/analyzerProcess.js'

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

  @column()
  declare analyzerProcessId: string // Clave foránea que conecta con AnalyzerProcess

  @belongsTo(() => AnalyzerProcess)
  declare analyzerProcess: BelongsTo<typeof AnalyzerProcess>

  @computed()
  public get needProcess(): boolean {
    return this.analyzerProcess?.currentStage !== 'finished'
  }
}
