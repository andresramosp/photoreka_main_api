import { DateTime } from 'luxon'
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import Photo from '../photo.js'
import { AnalyzerTask } from './analyzerTask.js'
import { getTaskList } from '../../analyzer_packages.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import _ from 'lodash'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

export type AnalyzerMode =
  | 'adding'
  | 'remake_all'
  | 'remake_task'
  | 'remake_process'
  | 'retry_process'
export type ModelType = 'GPT' | 'Molmo'
export type StageType =
  | 'init'
  | 'clip_embeddings'
  | 'vision_context_story_accents'
  | 'tags_context_story'
  | 'tags_visual_accents'
  | 'chunks_context_story_visual_accents'
  | 'visual_color_embedding_task'
  | 'topological_tags'
  | 'preprocessed' // Nuevo estado para pre-análisis
  | 'finished'
  | 'failed'
export type ProcessSheet = {
  [taskName: string]: {
    pendingPhotoIds: number[]
    completedPhotoIds: number[]
    batchId?: string
  }
}

import HealthPhotoService from '../../services/health_photo_service.js'

export default class AnalyzerProcess extends BaseModel {
  // Cache de health para fotos
  private healthCache: Map<number, any> = new Map()
  /**
   * Precarga el health de todas las fotos del proceso en paralelo y lo cachea
   */
  public async preloadPhotoHealth(): Promise<void> {
    if (this.healthCache.size > 0) return // Ya está cacheado
    if (!this.photos || this.photos.length === 0) return
    const photoIds = this.photos.map((p: any) => p.id)
    const healthArr = await Promise.all(
      photoIds.map((photoId) => HealthPhotoService.photoHealth(photoId))
    )
    photoIds.forEach((id, idx) => {
      this.healthCache.set(id, healthArr[idx])
    })
    logger.info(`Health precargado para ${photoIds.length} fotos`)
  }

  /**
   * Devuelve el health de una foto desde el cache
   */
  public getPhotoHealthFromCache(photoId: number): any {
    return this.healthCache.get(photoId)
  }

  /**
   * Limpia el cache de health
   */
  public clearHealthCache(): void {
    this.healthCache.clear()
  }
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare packageId: string

  @column()
  declare mode: AnalyzerMode

  @column()
  declare processSheet: ProcessSheet | null

  declare tasks: AnalyzerTask[] | null

  @column()
  declare currentStage: StageType | null

  @column()
  declare userId: number | null

  declare autoRetry: boolean | null

  declare maxAttempts: number | null

  declare attempts: number | null

  declare fastMode: boolean

  declare isPreprocess: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Photo, {
    foreignKey: 'analyzerProcessId',
  })
  declare photos: HasMany<typeof Photo>

  public async initialize(
    photosForProcess: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'adding',
    fastMode: boolean
  ) {
    this.mode = mode
    this.packageId = packageId
    this.tasks = getTaskList(packageId, this)
    this.currentStage = 'init'
    this.autoRetry = true
    this.maxAttempts = 2
    this.fastMode = fastMode
    await this.save()

    await this.setProcessPhotos(photosForProcess)
    if (this.mode !== 'retry_process') {
      this.initializeProcessSheet()
      await this.save()
    }
  }

  private async setProcessPhotos(photos: Photo[]) {
    const newPhotosIds = photos.map((p) => p.id)

    // Desasociar fotos que ya no están en el proceso
    await Photo.query()
      .where('analyzer_process_id', this.id)
      .whereNotIn('id', newPhotosIds)
      .update({ analyzer_process_id: null })

    // Asociar nuevas fotos al proceso
    await Photo.query().whereIn('id', newPhotosIds).update({ analyzer_process_id: this.id })

    // Recargar el proceso con las fotos preload
    const updatedProcess = await AnalyzerProcess.query()
      .where('id', this.id)
      .preload('photos')
      .firstOrFail()

    this.photos = updatedProcess.photos
    await this.save()
  }

  private initializeProcessSheet() {
    if (!this.tasks) return
    const allPhotoIds = this.photos.map((photo) => photo.id)
    const sheet: ProcessSheet = {}
    for (const task of this.tasks) {
      sheet[task.name] = {
        pendingPhotoIds: [...allPhotoIds],
        completedPhotoIds: [],
      }
    }
    this.processSheet = sheet
  }

  public getPendingPhotosForTask(taskName: string): number[] {
    return this.processSheet?.[taskName]?.pendingPhotoIds || []
  }

  public getCompletedPhotosForTask(taskName: string): number[] {
    return this.processSheet?.[taskName]?.completedPhotoIds || []
  }

  public async markPhotosCompleted(taskName: string, photoIds: number[]) {
    if (!this.processSheet || !this.processSheet[taskName]) return

    const task = this.processSheet[taskName]

    const photoIdsSet = new Set(photoIds)

    // Eliminar IDs de pending (aunque no estuvieran, para garantizar idempotencia)
    task.pendingPhotoIds = task.pendingPhotoIds.filter((id) => !photoIdsSet.has(id))

    // Añadir a completed, evitando duplicados
    const existingCompleted = new Set(task.completedPhotoIds)
    for (const id of photoIds) {
      if (!existingCompleted.has(id)) {
        task.completedPhotoIds.push(id)
      }
    }

    await this.save()
  }

  public formatProcessSheet(): string {
    let output = '\n=== Process Sheet ===\n'

    for (const [taskName, taskState] of Object.entries(this.processSheet as ProcessSheet)) {
      output += `\n▶ ${_.startCase(_.toLower(taskName))}:\n`

      const allPhotoIds = new Set([...taskState.pendingPhotoIds, ...taskState.completedPhotoIds])

      const sortedPhotoIds = Array.from(allPhotoIds).sort((a, b) => a - b)

      for (const photoId of sortedPhotoIds) {
        const isCompleted = taskState.completedPhotoIds.includes(photoId)
        const mark = isCompleted ? '✅' : '❌'
        output += `  ${mark} Foto ID ${photoId}\n`
      }
    }

    return output
  }
}
