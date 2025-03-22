import { BaseModel, column, belongsTo, computed } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Tag from './tag.js'

export default class TagPhoto extends BaseModel {
  public static table = 'tags_photos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare photoId: number

  @column()
  declare tagId: number

  @column()
  declare category: string

  @column()
  declare area: string

  @computed()
  public get name() {
    return this.tag.name
  }

  @computed()
  public get group() {
    return this.tag.group
  }

  @column()
  declare parentId?: number

  @belongsTo(() => Tag, {
    foreignKey: 'tagId',
  })
  declare tag: BelongsTo<typeof Tag>

  @belongsTo(() => TagPhoto, {
    localKey: 'id',
    foreignKey: 'parentId',
  })
  declare parent: BelongsTo<typeof TagPhoto>
}
