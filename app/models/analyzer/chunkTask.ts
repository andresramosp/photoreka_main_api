import DescriptionChunk from '#models/descriptionChunk'
import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import { AnalyzerTask } from './analyzerTask.js'
import AnalyzerProcess from './analyzerProcess.js'
import Logger, { LogLevel } from '../../utils/logger.js'
import ModelsService from '../../services/models_service.js'

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
    const batchEmbeddingsSize = 50 // tamaño inicial del lote

    if (!this.data) {
      this.data = {}
    }

    // Inicializar el array de chunks para cada foto si no existe
    for (const photo of pendingPhotos) {
      if (!this.data[photo.id]) {
        this.data[photo.id] = []
      }
    }

    for (let photo of pendingPhotos) {
      await photo.refresh()
      if (!photo.descriptions || typeof photo.descriptions !== 'object') {
        throw new Error('No descriptions found for this photo')
      }

      for (const category of this.descriptionSourceFields) {
        const description = photo.descriptions[category]
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

    const allChunks = Object.values(this.data).flat()
    for (let i = 0; i < allChunks.length; i += batchEmbeddingsSize) {
      const batch = allChunks.slice(i, i + batchEmbeddingsSize)
      const texts = batch.map((chunk) => chunk.chunk)
      logger.info(
        `Obteniendo embeddings para batch de ${texts.length} chunks (${i + 1}-${i + texts.length} de ${allChunks.length})`
      )
      const { embeddings } = await this.modelsService.getEmbeddings(texts)

      // Asignar embeddings a los chunks
      batch.forEach((chunk, index) => {
        chunk.embedding = embeddings[index]
      })
    }
  }

  async commit(): Promise<void> {
    // Fase 1: Eliminar todos los chunks existentes de las fotos procesadas
    const photoIds = Object.keys(this.data).map(Number)
    await DescriptionChunk.query().whereIn('photoId', photoIds).delete()

    // Fase 2: Guardar todos los nuevos chunks
    await Promise.all(
      Object.values(this.data)
        .flat()
        .map((chunk) => chunk.save())
    )

    await this.analyzerProcess.markPhotosCompleted(this.name, photoIds)
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
