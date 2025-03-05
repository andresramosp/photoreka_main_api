import { DateTime } from 'luxon'
import { BaseModel, column, computed, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import type { HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'
import Tag from './tag.js'
import DescriptionChunk from './descriptionChunk.js'

export default class Photo extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare descriptionShort: string

  @column()
  declare descriptionGeneric: string

  @column()
  declare descriptionGenre: string

  @column()
  declare descriptionTopologic: string

  @column()
  declare processed: boolean

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

  @computed()
  public get description() {
    return `CONTEXT: ${this.descriptionShort} | \n TOPOLOGIC: ${this.descriptionTopologic} | STORY \n ${this.descriptionGenre} | ARTISTIC \n ${this.descriptionGeneric}`
    return [
      this.descriptionShort,
      this.descriptionGeneric,
      this.descriptionGenre,
      this.descriptionTopologic,
    ].join('   |   ')
  }
}
