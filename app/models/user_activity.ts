import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import User from './user.js'

export type ActivityType =
  | 'login'
  | 'logout'
  | 'register'
  | 'upload_photo'
  | 'delete_photo'
  | 'update_photo'
  | 'view_photo'
  | 'get_photos_batch'
  | 'check_duplicates'
  | 'delete_duplicates'
  | 'photo_insight'
  | 'search'
  | 'search_text'
  | 'search_visual'
  | 'create_collection'
  | 'update_collection'
  | 'delete_collection'
  | 'add_photo_to_collection'
  | 'remove_photo_from_collection'
  | 'analyze_photo'
  | 'tag_photo'
  | 'create_tag'
  | 'delete_tag'
  | 'generate_embeddings'
  | 'update_profile'
  | 'change_password'
  | 'view_catalog'
  | 'view_usage'
  | 'warmup_system'
  | 'api_call'
  | 'error'

export type ActivityLevel = 'info' | 'warning' | 'error'

export default class UserActivity extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number

  @column()
  declare type: ActivityType

  @column()
  declare level: ActivityLevel

  @column()
  declare action: string

  @column()
  declare description: string | null

  @column()
  declare metadata: Record<string, any> | null

  @column()
  declare ipAddress: string | null

  @column()
  declare userAgent: string | null

  @column()
  declare endpoint: string | null

  @column()
  declare statusCode: number | null

  @column()
  declare responseTime: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  // Relación con User
  @belongsTo(() => User)
  declare user: BelongsTo<typeof User>
}
