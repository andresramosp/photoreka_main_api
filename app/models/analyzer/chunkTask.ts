import DescriptionChunk from '#models/descriptionChunk'
import pLimit from 'p-limit'
import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import AnalyzerProcess from './analyzerProcess.js'

const logger = Logger.getInstance('AnalyzerProcess', 'ChunkTask')
logger.setLevel(LogLevel.DEBUG)

export type SplitMethod =
  | { type: 'split_by_props' }
  | { type: 'split_by_pipes' }
  | { type: 'split_by_size'; maxLength: number }

export class ChunkTask extends AnalyzerTask {
  declare descriptionSourceFields: DescriptionType[]
  declare descriptionsChunksMethod: Record<DescriptionType, SplitMethod>
  declare data: Record<string, DescriptionChunk[]>

  async process(pendingPhotos: Photo[]): Promise<void> {
    const batchSize = 50 // procesar de a 50 fotos por vez
    const batchEmbeddingsSize = 200 // tamaño inicial del lote para embeddings
    const embeddingsConcurrency = 3 // concurrencia para embeddings
    const embeddingsDelay = 1000 // 1 segundo de demora entre batches de embeddings

    if (!this.data) {
      this.data = {}
    }

    // Filtrar fotos: solo aquellas que tengan TODOS los campos requeridos
    const validPhotos: Photo[] = []
    const skippedPhotoIds: number[] = []

    for (const photo of pendingPhotos) {
      await photo.refresh()
      const hasAllDescriptions = this.descriptionSourceFields.every(
        (field) => photo.descriptions && photo.descriptions[field]
      )
      if (hasAllDescriptions) {
        validPhotos.push(photo)
      } else {
        skippedPhotoIds.push(photo.id)
      }
    }

    if (skippedPhotoIds.length > 0) {
      logger.info(
        `Saltando ${skippedPhotoIds.length} fotos por no tener descripciones requeridas: ${skippedPhotoIds.join(', ')}`
      )
    }
    if (validPhotos.length === 0) {
      logger.warn('No hay fotos válidas para procesar.')
      return
    }

    // Procesar en lotes para evitar acumular demasiado en memoria
    for (let i = 0; i < validPhotos.length; i += batchSize) {
      const photoBatch = validPhotos.slice(i, i + batchSize)

      // Limpiar data antes de procesar el lote
      this.data = {}

      // Inicializar el array de chunks para cada foto del lote
      for (const photo of photoBatch) {
        this.data[photo.id] = []
      }

      logger.info(
        `Procesando lote de fotos ${i + 1}-${i + photoBatch.length} de ${validPhotos.length}`
      )

      // Generar chunks para el lote actual
      for (let photo of photoBatch) {
        for (const category of this.descriptionSourceFields) {
          const description = photo.descriptions!![category]
          if (!description) continue

          let descriptionChunks
          const splitMethod = this.descriptionsChunksMethod[category]
            ? this.descriptionsChunksMethod[category]
            : { type: 'split_by_size', maxLength: 300 }

          if (splitMethod.type === 'split_by_pipes') {
            descriptionChunks = description.split('|').filter((ch: string) => ch.length > 0)
          } else if (splitMethod.type === 'split_by_size') {
            descriptionChunks = this.splitIntoChunks(description, splitMethod.maxLength)
          } else {
            throw new Error(`Método de división no soportado: ${splitMethod.type}`)
          }

          // Crear los chunks sin embeddings y añadirlos al array existente
          const chunks = descriptionChunks.map((chunk) => {
            const descriptionChunk = new DescriptionChunk()
            descriptionChunk.photoId = photo.id
            descriptionChunk.chunk = chunk
            descriptionChunk.category = category
            return descriptionChunk
          })

          this.data[photo.id].push(...chunks)
        }
      }

      // Obtener embeddings para el lote actual
      const allChunks = Object.values(this.data).flat()
      if (allChunks.length > 0) {
        const limit = pLimit(embeddingsConcurrency)
        const embeddingTasks: Promise<void>[] = []

        for (let j = 0; j < allChunks.length; j += batchEmbeddingsSize) {
          const batch = allChunks.slice(j, j + batchEmbeddingsSize)
          const taskIndex = Math.floor(j / batchEmbeddingsSize)

          const embeddingTask = limit(async () => {
            if (taskIndex > 0) {
              await new Promise((resolve) => setTimeout(resolve, embeddingsDelay))
            }
            const texts = batch.map((chunk) => chunk.chunk)
            logger.info(
              `Obteniendo embeddings para batch de ${texts.length} chunks (${j + 1}-${j + texts.length} de ${allChunks.length})`
            )
            const { embeddings } = await this.modelsService.getEmbeddingsCPU(texts)

            // Asignar embeddings a los chunks
            batch.forEach((chunk, index) => {
              chunk.embedding = embeddings[index]
            })
          })
          embeddingTasks.push(embeddingTask)
        }

        await Promise.all(embeddingTasks)
        // Hacer commit parcial del lote actual
        await this.commit(photoBatch)
      }
    }
  }

  async commit(batch: Photo[]): Promise<void> {
    const batchPhotoIds = batch.map((p) => p.id)
    const photoIdsWithChunks = batchPhotoIds.filter((photoId) => this.data[photoId])

    if (photoIdsWithChunks.length === 0) {
      logger.info('No hay chunks para hacer commit')
      return
    }

    logger.info(`Haciendo commit de chunks para ${photoIdsWithChunks.length} fotos`)

    // Fase 1: Eliminar todos los chunks existentes de las fotos especificadas
    await DescriptionChunk.query().whereIn('photoId', photoIdsWithChunks).delete()

    // Fase 2: Guardar solo los chunks de las fotos especificadas
    const chunksToSave = photoIdsWithChunks.flatMap((photoId) => this.data[photoId])

    if (chunksToSave.length > 0) {
      await Promise.all(chunksToSave.map((chunk) => chunk.save()))
      logger.info(
        `Guardados ${chunksToSave.length} chunks para fotos: ${photoIdsWithChunks.join(', ')}`
      )
    }

    // Fase 3: Limpiar de data los chunks que ya se guardaron
    photoIdsWithChunks.forEach((photoId) => {
      delete this.data[photoId]
    })
  }

  private splitIntoChunks(desc: string, maxLength: number = 300): string[] {
    const sentences = desc.split(/(?<=[.!?])\s+/)
    const chunks: string[] = []
    let currentChunk = ''

    for (const sentence of sentences) {
      const withSentence = currentChunk ? currentChunk + ' ' + sentence : sentence

      if (withSentence.length <= maxLength) {
        currentChunk = withSentence
      } else {
        if (currentChunk) chunks.push(currentChunk)
        currentChunk = sentence // empieza nuevo chunk incluso si ya pasa de maxLength
      }
    }

    if (currentChunk) chunks.push(currentChunk)

    return chunks
  }
}
