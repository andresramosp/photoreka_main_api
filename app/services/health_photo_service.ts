// @ts-nocheck

import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import Photo from '#models/photo'
import PhotoManager from '../managers/photo_manager.js'
type Check = { label: string; ok: boolean }

export default class HealthPhotoService {
  /** Representa un check de integridad */

  /* ───────── 1) photoHealth ───────── */
  public static async photoHealth(photoId: number) {
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

    // push('descriptions.artistic_scores', !!d.artistic_scores)

    const visualAspects = d.visual_aspects || {}
    push(
      'descriptions.visual_aspects.genre',
      !!(visualAspects.genre && visualAspects.genre.length > 0)
    )

    push(
      'descriptions.visual_aspects.orientation',
      !!(visualAspects.orientation && visualAspects.orientation.length > 0)
    )

    push('tags.any', photo.tags.length > 0)
    push(
      'tags.context_story',
      photo.tags.some((t) => t.category === 'context_story')
    )
    push(
      'tags.visual_accents',
      photo.tags.some((t) => t.category === 'visual_accents')
    )
    push(
      'tags.visual_aspects',
      photo.tags.some((t) => t.category === 'visual_aspects')
    )

    push('descriptionChunks.any', photo.descriptionChunks.length > 0)
    photo.descriptionChunks.forEach((c) =>
      push(`descriptionChunk#${c.id}.embedding`, !!c.embedding)
    )

    push('photo.color_histogram', !!photo.colorHistogram) // O el campo correcto donde almacenes el histograma
    push(
      'tags.topological',
      photo.tags.some((t) => t.area !== null && t.area !== '' && t.area !== undefined)
    )

    photo.tags.forEach((t) =>
      push(`tagPhoto#${t.id}.tag#${t.tagId}.embedding`, !!(t.tag && t.tag.embedding))
    )

    // if (missing.length > 0) {
    //   console.log(`❌ Foto #${photoId} tiene campos faltantes: ${missing.join(', ')}`)
    // }
    return { ok: missing.length === 0, checks, missing }
  }

  /* ───────── 2) healthForUser ───────── */
  public static async healthForUser(userId: number, verbose = false) {
    const mark = (ok: boolean) => (ok ? '✅' : '❌')

    const photoManager = new PhotoManager()
    const photos = await photoManager.getPhotosByUser(userId)

    const reports = await Promise.all(
      photos.map(async (p) => ({
        photoId: p.id,
        ...(await HealthPhotoService.photoHealth(p.id)),
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
  public static async healthForProcess(process: AnalyzerProcess, verbose = false) {
    const mark = (ok: boolean) => (ok ? '✅' : '❌')
    const photos = process.photos || []
    const reports = await Promise.all(
      photos.map(async (p) => ({
        photoId: p.id,
        ...(await HealthPhotoService.photoHealth(p.id)),
      }))
    )
    reports.sort((a, b) => a.photoId - b.photoId)
    if (verbose) {
      reports.forEach((r) => {
        console.log(`\n⟐  Foto #${r.photoId} ${mark(r.ok)}`)
        r.checks.forEach(({ label, ok }) => console.log(`  ${mark(ok)} ${label}`))
      })
      const failed = reports.filter((r) => !r.ok)
      if (failed.length) {
        console.log('\n❌ Fotos con campos faltantes:')
        failed.forEach((r) => console.log(`  • #${r.photoId} → ${r.missing.join(', ')}`))
      } else {
        console.log('\n✅ Todas las fotos están completas')
      }
    }
    return reports
  }

  // Solo informativa al final del proceso, y para saber si iniciar retry automático
  public static async updateSheetWithHealth(process: AnalyzerProcess) {
    const packageDef = (await import('../../app/analyzer_packages.js')).packages.find(
      (p) => p.id === process.packageId
    )
    if (packageDef) {
      const healthReports = await HealthPhotoService.healthForProcess(process, false)
      for (const taskDef of packageDef.tasks) {
        const taskName = taskDef.name
        const checksForTask = taskDef.checks || []
        const completedPhotoIds = []
        for (const report of healthReports) {
          // Para cada foto, verificar si pasa todos los checks de la tarea
          const ok = checksForTask.every((checkPattern) => {
            if (checkPattern.includes('*')) {
              // Patrón tipo descriptionChunk#*.embedding
              const regex = new RegExp('^' + checkPattern.replace(/\*/g, '\\d+') + '$')
              return report.checks.filter((c) => regex.test(c.label)).every((c) => c.ok)
            } else {
              const check = report.checks.find((c) => c.label === checkPattern)
              return check ? check.ok : false
            }
          })
          if (ok) completedPhotoIds.push(report.photoId)
        }
        await process.markPhotosCompleted(taskName, completedPhotoIds)
      }
      await process.save()
    }
  }
}
