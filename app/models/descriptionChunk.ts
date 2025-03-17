import { BaseModel, beforeSave, column } from '@adonisjs/lucid/orm'

export default class DescriptionChunk extends BaseModel {
  public static table = 'descriptions_chunks'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare photoId: string

  @column()
  declare category: string

  @column()
  declare area: 'left' | 'right' | 'upper' | 'bottom' | 'middle'

  @column()
  declare chunk: string

  @column({ serializeAs: null })
  declare embedding: string

  // Hook para formatear embedding antes de guardar
  @beforeSave()
  public static formatEmbedding(desc: DescriptionChunk) {
    if (desc.embedding && Array.isArray(desc.embedding)) {
      // Convierte el array en formato pgvector: '[value1,value2,...]'
      desc.embedding = `[${(desc.embedding as any[]).join(',')}]`
    }
  }
}
