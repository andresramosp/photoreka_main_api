import { DateTime } from 'luxon'
import { BaseModel, column, manyToMany, belongsTo } from '@adonisjs/lucid/orm'
import type { ManyToMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import User from './user.js'
import Photo from './photo.js'

export default class Collection extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare name: string

  @column()
  declare description: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>

  @manyToMany(() => Photo, {
    pivotTable: 'collection_photos',
    localKey: 'id',
    pivotForeignKey: 'collection_id',
    relatedKey: 'id',
    pivotRelatedForeignKey: 'photo_id',
  })
  declare photos: ManyToMany<typeof Photo>
}
