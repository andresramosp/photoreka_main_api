import { DateTime } from 'luxon'
import { BaseModel, beforeSave, column, computed, manyToMany } from '@adonisjs/lucid/orm'
import Photo from './photo.js'

export default class Tag extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare group: string

  @computed()
  public get category() {
    return this.$extras.pivot_category
  }

  @computed()
  public get area() {
    return this.$extras.pivot_area
  }

  @column()
  declare children: Record<string, []>

  @column({ serializeAs: null })
  declare embedding: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  // Hook para formatear embedding antes de guardar
  @beforeSave()
  public static formatEmbedding(tag: Tag) {
    if (tag.embedding && Array.isArray(tag.embedding)) {
      // Convierte el array en formato pgvector: '[value1,value2,...]'
      tag.embedding = `[${(tag.embedding as any[]).join(',')}]`
    }
  }
}
