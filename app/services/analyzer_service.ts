// @ts-nocheck

import AnalyzerProcess, { AnalyzerMode } from '#models/analyzer/analyzerProcess'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import Logger, { LogLevel } from '../utils/logger.js'
import PhotoImageService from './photo_image_service.js'
import { invalidateCache } from '../decorators/withCache.js'
import chalk from 'chalk' // ← NUEVO
import PhotoManager from '../managers/photo_manager.js'

const logger = Logger.getInstance('AnalyzerProcess')
logger.setLevel(LogLevel.DEBUG)

/** Representa un check de integridad */
type Check = { label: string; ok: boolean }

export default class AnalyzerProcessRunner {
  private process: AnalyzerProcess
  private modelsService: ModelsService
  private photoImageService: PhotoImageService
  private photoManager: PhotoManager

  constructor() {
    this.process = new AnalyzerProcess()
    this.modelsService = new ModelsService()
    this.photoManager = new PhotoManager()
    this.photoImageService = PhotoImageService.getInstance()
  }

  /** ────────────────────────────────────
   *  INICIALIZACIÓN Y EJECUCIÓN PRINCIPAL
   * ──────────────────────────────────── */

  public async initProcess(
    userPhotos: Photo[],
    packageId: string,
    mode: AnalyzerMode = 'first',
    processId?: number
  ) {
    await invalidateCache(`getPhotos_${1234}`)
    await invalidateCache(`getPhotosIdsByUser_${1234}`)

    if ((mode === 'retry_process' || mode === 'remake_process') && processId) {
      this.process = await AnalyzerProcess.query()
        .where('id', processId)
        .preload('photos')
        .firstOrFail()
    }

    await this.process.initialize(userPhotos, packageId, mode)
    await this.changeStage(
      `Proceso Iniciado | Paquete: ${packageId} | Modo ${mode}`,
      'vision_tasks'
    )
  }

  public async *run() {
    if (!this.process || !this.process.tasks) throw new Exception('[ERROR] No process found')

    for (const task of this.process.tasks) {
      try {
        const pendingPhotos = await task.prepare(this.process)
        if (pendingPhotos.length) {
          await this.changeStage(
            `*** Iniciando tarea *** | ${task.getName()} | Fotos: ${pendingPhotos.length} | ${this.process.mode.toUpperCase()}`,
            task.name
          )
          await task.process(pendingPhotos)
          await task.commit(pendingPhotos)
          await this.changeStage(`*** Tarea completada *** | ${task.getName()}`)
        }
      } catch (error) {
        logger.error(`Error en tarea ${task.name}:`, error)
      }
    }

    await this.updateSheetWithHealth()

    await this.changeStage('***  Proceso Completado ***', 'finished')
    logger.info(`\n  ${this.process.formatProcessSheet()} \n `)

    await invalidateCache(`getPhotos_${1234}`)
    await invalidateCache(`getPhotosIdsByUser_${1234}`)

    yield { type: 'analysisComplete', data: { costs: [] } }

    // NUEVO: Retry automático si autoRetry está activo Y hay fotos fallidas
    yield* this.handleAutoRetry()
  }

  private async changeStage(message: string, nextStage: string = null) {
    logger.info(message, false)
    if (nextStage) {
      this.process.currentStage = nextStage
      await this.process.save()
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /* ─────────────────────────────────────
   *  MÉTODOS DE "HEALTH CHECK" INTEGRADOS
   * ───────────────────────────────────── */

  /* ───────── 1) photoHealth ───────── */
  public async photoHealth(photoId: number) {
    const checks: Check[] = []
    const missing: string[] = []

    const photo = await Photo.query()
      .where('id', photoId)
      .preload('detections')
      .preload('tags', (q) => q.preload('tag'))
      .preload('descriptionChunks')
      .first()

    checks.push({ label: 'photo.exists', ok: !!photo })
    if (!photo) return { ok: false, checks, missing: ['photo'] }

    const push = (label: string, ok: boolean) => {
      checks.push({ label, ok })
      if (!ok) missing.push(label)
    }

    push('photo.embedding', !!photo.embedding)
    // push('detections', photo.detectionAreas.length > 0)

    const d = photo.descriptions ?? {}
    push('descriptions.context', !!d.context)
    push('descriptions.story', !!d.story)
    push('descriptions.visual_accents', !!d.visual_accents)

    push('tags.any', photo.tags.length > 0)
    push(
      'tags.context_story',
      photo.tags.some((t) => t.category === 'context_story')
    )
    push(
      'tags.visual_accents',
      photo.tags.some((t) => t.category === 'visual_accents')
    )

    push('descriptionChunks.any', photo.descriptionChunks.length > 0)
    photo.descriptionChunks.forEach((c) =>
      push(`descriptionChunk#${c.id}.embedding`, !!c.embedding)
    )

    photo.tags.forEach((t) =>
      push(`tagPhoto#${t.id}.tag#${t.tagId}.embedding`, !!(t.tag && t.tag.embedding))
    )

    return { ok: missing.length === 0, checks, missing }
  }

  /* ───────── 2) healthForUser ───────── */
  public async healthForUser(userId: number, verbose = false) {
    const mark = (ok: boolean) => (ok ? '✅' : '❌')

    const photos = await this.photoManager.getPhotos(userId)

    const reports = await Promise.all(
      photos.map(async (p) => ({
        photoId: p.id,
        ...(await this.photoHealth(p.id)),
      }))
    )

    // Ordenar por ID
    reports.sort((a, b) => a.photoId - b.photoId)

    // salida por consola
    reports.forEach((r) => {
      if (r.ok && !verbose) {
        console.log(`Foto #${r.photoId} ${mark(true)} OK`)
        return
      }
      console.log(`\n⟐  Foto #${r.photoId} ${mark(r.ok)}`)
      r.checks
        .filter((c) => verbose || !c.ok)
        .forEach(({ label, ok }) => console.log(`  ${mark(ok)} ${label}`))
    })

    // resumen
    const failed = reports.filter((r) => !r.ok)
    if (failed.length) {
      console.log('\n❌ Fotos con campos faltantes:')
      failed.forEach((r) => console.log(`  • #${r.photoId} → ${r.missing.join(', ')}`))
    } else {
      console.log('\n✅ Todas las fotos están completas')
    }

    return reports
  }

  /* ───────── NUEVO: healthForProcess ───────── */
  public async healthForProcess(verbose = false) {
    const mark = (ok: boolean) => (ok ? '✅' : '❌')
    const photos = this.process.photos || []
    const reports = await Promise.all(
      photos.map(async (p) => ({
        photoId: p.id,
        ...(await this.photoHealth(p.id)),
      }))
    )
    reports.sort((a, b) => a.photoId - b.photoId)
    reports.forEach((r) => {
      if (r.ok && !verbose) {
        console.log(`Foto #${r.photoId} ${mark(true)} OK`)
        return
      }
      console.log(`\n⟐  Foto #${r.photoId} ${mark(r.ok)}`)
      r.checks
        .filter((c) => verbose || !c.ok)
        .forEach(({ label, ok }) => console.log(`  ${mark(ok)} ${label}`))
    })
    const failed = reports.filter((r) => !r.ok)
    if (failed.length) {
      console.log('\n❌ Fotos con campos faltantes:')
      failed.forEach((r) => console.log(`  • #${r.photoId} → ${r.missing.join(', ')}`))
    } else {
      console.log('\n✅ Todas las fotos están completas')
    }
    return reports
  }

  // NUEVO: Función privada para actualizar la sheet usando health y el mapeo de checks
  private async updateSheetWithHealth() {
    const packageDef = (await import('../../app/analyzer_packages.js')).packages.find(
      (p) => p.id === this.process.packageId
    )
    if (packageDef) {
      const healthReports = await this.healthForProcess(false)
      for (const taskDef of packageDef.tasks) {
        const taskName = taskDef.name
        const checksForTask = taskDef.checks || []
        const completedPhotoIds = []
        for (const report of healthReports) {
          // Para cada foto, verificar si pasa todos los checks de la tarea
          const ok = checksForTask.every((checkPattern) => {
            if (checkPattern.includes('*')) {
              // Patrón tipo descriptionChunk#*.embedding
              const regex = new RegExp('^' + checkPattern.replace('*', '\\d+') + '$')
              return report.checks.filter((c) => regex.test(c.label)).every((c) => c.ok)
            } else {
              const check = report.checks.find((c) => c.label === checkPattern)
              return check ? check.ok : false
            }
          })
          if (ok) completedPhotoIds.push(report.photoId)
        }
        await this.process.markPhotosCompleted(taskName, completedPhotoIds)
      }
      await this.process.save()
    }
  }

  // NUEVO: Función privada para manejar el autoRetry
  private async *handleAutoRetry() {
    if (this.process.autoRetry) {
      // Verificar si hay fotos pendientes en alguna tarea
      const sheet = this.process.processSheet || {}
      const hayFallidas = Object.values(sheet).some(
        (task: any) => Array.isArray(task.pendingPhotoIds) && task.pendingPhotoIds.length > 0
      )
      const maxAttempts = this.process.maxAttempts ?? 3
      const attempts = this.process.attempts ?? 0
      if (hayFallidas && attempts < maxAttempts) {
        logger.info(
          `AutoRetry activo: lanzando retry_process automáticamente (hay fotos fallidas, intento ${attempts + 1}/${maxAttempts})...`
        )
        this.process.mode = 'retry_process'
        this.process.attempts = attempts + 1
        await this.process.save()
        yield* this.run()
      } else if (hayFallidas) {
        logger.info(
          `autoRetry: se alcanzó el máximo de intentos (${maxAttempts}). No se lanza retry_process.`
        )
      } else {
        logger.info('autoRetry activo, pero no hay fotos fallidas. No se lanza retry_process.')
      }
    }
  }
}
