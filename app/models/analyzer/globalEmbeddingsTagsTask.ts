// @ts-nocheck

import Tag from '#models/tag'
import VectorService from '#services/vector_service'
import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'
import AnalyzerProcess from './analyzerProcess.js'

const logger = Logger.getInstance('AnalyzerProcess', 'GlobalEmbeddingsTagsTask')
logger.setLevel(LogLevel.DEBUG)

export class GlobalEmbeddingsTagsTask extends AnalyzerTask {
  private tagsToProcess: Tag[] = []

  async process(photos: Photo[], process?: AnalyzerProcess): Promise<void> {
    logger.debug('Buscando tags sin embeddings en la BD...')

    // Obtener todos los tags que no tienen embedding
    this.tagsToProcess = await Tag.query().whereNull('embedding')

    logger.info(`Encontrados ${this.tagsToProcess.length} tags sin embeddings`)
  }

  async commit(): Promise<void> {
    if (this.tagsToProcess.length === 0) {
      logger.info('No hay tags para procesar embeddings')
      return
    }

    const batchEmbeddingsSize = 150
    const tagNames = this.tagsToProcess.map((tag) => tag.name)

    logger.info(
      `Procesando embeddings para ${tagNames.length} tags en lotes de ${batchEmbeddingsSize}`
    )

    // Procesar en lotes
    const pLimit = (await import('p-limit')).default
    const concurrencyLimit = 25
    for (let i = 0; i < tagNames.length; i += batchEmbeddingsSize) {
      const batch = tagNames.slice(i, i + batchEmbeddingsSize)
      const batchTags = this.tagsToProcess.slice(i, i + batchEmbeddingsSize)

      logger.debug(
        `Obteniendo embeddings para lote ${Math.floor(i / batchEmbeddingsSize) + 1}/${Math.ceil(tagNames.length / batchEmbeddingsSize)} (${batch.length} tags)`
      )

      try {
        // Obtener embeddings para el lote
        const { embeddings } = await this.modelsService.getEmbeddingsCPU(batch)

        // Guardar en paralelo con límite de concurrencia
        const limit = pLimit(concurrencyLimit)
        await Promise.all(
          batchTags.map((tag, j) =>
            limit(async () => {
              const embedding = embeddings[j]
              if (embedding) {
                tag.embedding = embedding
                await tag.save()
              }
            })
          )
        )

        logger.debug(`Lote ${Math.floor(i / batchEmbeddingsSize) + 1} completado`)
      } catch (error) {
        logger.error(`Error procesando lote ${Math.floor(i / batchEmbeddingsSize) + 1}:`, error)
        // Continuar con el siguiente lote en caso de error
      }
    }

    logger.info(`Embeddings procesados para ${this.tagsToProcess.length} tags`)
  }
}
