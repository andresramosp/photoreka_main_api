import { DateTime } from 'luxon'
import { BaseModel, column, computed, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import type { HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'
import Tag from './tag.js'
import DescriptionChunk from './descriptionChunk.js'

export type DescriptionType = 'context' | 'story' | 'topology' | 'artistic'
export type StageType = 'context' | 'story' | 'topology' | 'artistic' | 'tags'
export type PhotoDescriptions = Record<DescriptionType, string>
export type AnalysisStatus = Record<StageType, boolean>

export default class Photo extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare descriptions: PhotoDescriptions | null

  @column()
  declare processed: AnalysisStatus | null

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

  @manyToMany(() => Tag, {
    pivotTable: 'tags_photos',
    localKey: 'id',
    pivotForeignKey: 'photo_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'tag_id',
  })
  declare tags: ManyToMany<typeof Tag>

  @hasMany(() => DescriptionChunk, {
    foreignKey: 'photoId',
  })
  declare descriptionChunks: HasMany<typeof DescriptionChunk>

  public getProcessed(type: StageType): boolean {
    return this.processed?.[type] ?? false
  }

  public pendingProcesses(): StageType[] {
    return Object.entries(this.processed || {})
      .filter(([_, status]) => !status)
      .map(([type]) => type as StageType)
  }

  @computed()
  public get needProcess(): boolean {
    return (
      !this.getProcessed('context') ||
      !this.getProcessed('story') ||
      !this.getProcessed('topology') ||
      !this.getProcessed('tags')
    )
  }
}
