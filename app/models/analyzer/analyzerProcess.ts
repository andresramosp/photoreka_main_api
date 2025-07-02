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

export type AnalyzerMode = 'adding' | 'remake' | 'retry'
export type ModelType = 'GPT' | 'Molmo'
export type StageType =
  | 'init'
  | 'vision_tasks'
  | 'tags_tasks'
  | 'embeddings_tags'
  | 'chunks_tasks'
  | 'embeddings_chunks'
  | 'finished'
  | 'failed'
export type ProcessSheet = {
  [taskName: string]: {
    pendingPhotoIds: number[]
    completedPhotoIds: number[]
  }
}

export default class AnalyzerProcess extends BaseModel {
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

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => Photo, {
    foreignKey: 'analyzerProcessId',
  })
  declare photos: HasMany<typeof Photo>

  public async initialize(userPhotos: Photo[], packageId: string, mode: AnalyzerMode = 'adding') {
    this.mode = mode
    this.packageId = packageId
    this.tasks = getTaskList(packageId, this)
    this.currentStage = 'init'
    await this.save()

    const photosToProcess = this.getInitialPhotos(userPhotos)
    await this.setProcessPhotos(photosToProcess)
    if (this.mode !== 'retry') {
      this.initializeProcessSheet()
      await this.save()
    }
  }

  private getInitialPhotos(userPhotos: Photo[]): Photo[] {
    switch (this.mode) {
      case 'adding':
        return userPhotos.filter((photo) => !photo.analyzerProcess)
      case 'remake': // incluye upgrade, siempre sobre todas las fotos
        return userPhotos
      default:
        return userPhotos.filter((photo) => photo.analyzerProcessId == this.id)
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
