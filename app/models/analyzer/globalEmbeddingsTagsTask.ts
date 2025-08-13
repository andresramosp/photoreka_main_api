// @ts-nocheck

import Tag from '#models/tag'
import DescriptionChunk from '#models/descriptionChunk'
import VectorService from '#services/vector_service'
import { AnalyzerTask } from './analyzerTask.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import Photo from '#models/photo'
import AnalyzerProcess from './analyzerProcess.js'

const logger = Logger.getInstance('AnalyzerProcess', 'GlobalEmbeddingsTagsTask')
logger.setLevel(LogLevel.DEBUG)

export class GlobalEmbeddingsTagsTask extends AnalyzerTask {
  private tagsToProcess: Tag[] = []
  private descriptionChunksToProcess: DescriptionChunk[] = []

  async process(photos: Photo[], process?: AnalyzerProcess): Promise<void> {
    logger.debug('Buscando tags sin embeddings en la BD...')

    // Obtener todos los tags que no tienen embedding
    this.tagsToProcess = await Tag.query().whereNull('embedding')

    logger.info(`Encontrados ${this.tagsToProcess.length} tags sin embeddings`)

    logger.debug('Buscando description chunks sin embeddings en la BD...')

    // Obtener todos los description chunks que no tienen embedding
    this.descriptionChunksToProcess = await DescriptionChunk.query().whereNull('embedding')

    logger.info(
      `Encontrados ${this.descriptionChunksToProcess.length} description chunks sin embeddings`
    )
  }

  async commit(): Promise<void> {
    // Procesar tags
    await this.processTagsEmbeddings()

    // Procesar description chunks
    await this.processDescriptionChunksEmbeddings()
  }

  private async processTagsEmbeddings(): Promise<void> {
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
        `Obteniendo embeddings para lote de tags ${Math.floor(i / batchEmbeddingsSize) + 1}/${Math.ceil(tagNames.length / batchEmbeddingsSize)} (${batch.length} tags)`
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

        logger.debug(`Lote de tags ${Math.floor(i / batchEmbeddingsSize) + 1} completado`)
      } catch (error) {
        logger.error(
          `Error procesando lote de tags ${Math.floor(i / batchEmbeddingsSize) + 1}:`,
          error
        )
        // Continuar con el siguiente lote en caso de error
      }
    }

    logger.info(`Embeddings procesados para ${this.tagsToProcess.length} tags`)
  }

  private async processDescriptionChunksEmbeddings(): Promise<void> {
    if (this.descriptionChunksToProcess.length === 0) {
      logger.info('No hay description chunks para procesar embeddings')
      return
    }

    const batchEmbeddingsSize = 150
    const chunkTexts = this.descriptionChunksToProcess.map((chunk) => chunk.chunk)

    logger.info(
      `Procesando embeddings para ${chunkTexts.length} description chunks en lotes de ${batchEmbeddingsSize}`
    )

    // Procesar en lotes
    const pLimit = (await import('p-limit')).default
    const concurrencyLimit = 25
    for (let i = 0; i < chunkTexts.length; i += batchEmbeddingsSize) {
      const batch = chunkTexts.slice(i, i + batchEmbeddingsSize)
      const batchChunks = this.descriptionChunksToProcess.slice(i, i + batchEmbeddingsSize)

      logger.debug(
        `Obteniendo embeddings para lote de description chunks ${Math.floor(i / batchEmbeddingsSize) + 1}/${Math.ceil(chunkTexts.length / batchEmbeddingsSize)} (${batch.length} chunks)`
      )

      try {
        // Obtener embeddings para el lote
        const { embeddings } = await this.modelsService.getEmbeddingsCPU(batch)

        // Guardar en paralelo con límite de concurrencia
        const limit = pLimit(concurrencyLimit)
        await Promise.all(
          batchChunks.map((chunk, j) =>
            limit(async () => {
              const embedding = embeddings[j]
              if (embedding) {
                chunk.embedding = embedding
                await chunk.save()
              }
            })
          )
        )

        logger.debug(
          `Lote de description chunks ${Math.floor(i / batchEmbeddingsSize) + 1} completado`
        )
      } catch (error) {
        logger.error(
          `Error procesando lote de description chunks ${Math.floor(i / batchEmbeddingsSize) + 1}:`,
          error
        )
        // Continuar con el siguiente lote en caso de error
      }
    }

    logger.info(
      `Embeddings procesados para ${this.descriptionChunksToProcess.length} description chunks`
    )
  }
}
