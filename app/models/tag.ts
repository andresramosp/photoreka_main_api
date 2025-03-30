import { DateTime } from 'luxon'
import { BaseModel, beforeSave, column, computed } from '@adonisjs/lucid/orm'

export const tagGroups = [
  'person',
  'animals',
  'objects',
  'toponym',
  'environment',
  'mood',
  'weather',
  'symbols',
  'abstract concept',
  'misc',
] as const

export type TagGroups = (typeof tagGroups)[number]

export default class Tag extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare group: TagGroups

  @computed()
  public get category() {
    return this.$extras.pivot_category
  }

  @computed()
  public get area() {
    return this.$extras.pivot_area
  }

  @column({ serializeAs: null })
  declare embedding: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @computed()
  public get parsedEmbedding(): number[] {
    return JSON.parse(this.embedding)
  }

  // Hook para formatear embedding antes de guardar
  @beforeSave()
  public static formatEmbedding(tag: Tag) {
    if (tag.embedding && Array.isArray(tag.embedding)) {
      // Convierte el array en formato pgvector: '[value1,value2,...]'
      tag.embedding = `[${(tag.embedding as any[]).join(',')}]`
    }
  }
}
