import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class DetectionPhoto extends BaseModel {
  public static table = 'detections_photos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare photoId: number

  @column()
  declare category: string

  @column({ columnName: 'x1' })
  declare x1: number

  @column({ columnName: 'y1' })
  declare y1: number

  @column({ columnName: 'x2' })
  declare x2: number

  @column({ columnName: 'y2' })
  declare y2: number
}
