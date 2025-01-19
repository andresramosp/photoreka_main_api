import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import type { HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'
import Tag from './tag.js'
import DescriptionChunk from './descriptionChunk.js'

export default class Photo extends BaseModel {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare description: string

  @column()
  declare title: string | null

  @column()
  declare metadata: Record<string, any> | null

  @column()
  declare name: string

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
}
