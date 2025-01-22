// @ts-nocheck

import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'
import Photo from '#models/photo'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

const cache = new NodeCache({ stdTTL: 3600 })

const partitions: any = {
  creatures: ['cat', 'feline'], // Desde "gato" hasta "animal"
  objects: ['chair', 'furniture'], // Desde "silla" hasta "mobiliario"
  vehicles: ['taxi', 'vehicle'], // Desde "coche" hasta "vehículo"
  emotions: ['joy', 'emotion'], // Desde "alegría" hasta "emoción"
  events: ['birthday', 'event'], // Desde "cumpleaños" hasta "evento"
  locations: ['paris', 'place'], // Desde "París" hasta "lugar"
  environment: ['tree', 'nature'],
}

interface ScoredPhoto {
  tagScore: number // Puntuación por tags
  // descScore: number // Puntuación por embeddings
  totalScore: number // Puntaje total calculado
}

interface ChunkedPhoto extends ScoredPhoto {
  chunks?: { proximity: number; text_chunk: string }[] // Chunks asociados a la foto
}

export default class EmbeddingsService {
  @MeasureExecutionTime
  public async findSimilarTagsToText(
    term: string,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    const modelsService = new ModelsService()
    let result = null

    let existingTag = await Tag.query().where('name', term).andWhereNotNull('embedding').first()
    if (existingTag) {
      result = this.findSimilarTagsToTag(existingTag, threshold, limit, metric)
    } else {
      let { embeddings } = await modelsService.getEmbeddings([term])
      result = this.findSimilarTagToEmbedding(embeddings[0], threshold, limit, metric)
    }

    return result
  }

  @MeasureExecutionTime
  public async findSimilarChunksToText(
    term: string,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number } // Parámetro opcional para filtrar por photo_id
  ) {
    const modelsService = new ModelsService()
    let result = null

    let { embeddings } = await modelsService.getEmbeddings([term])
    return this.findSimilarChunkToEmbedding(embeddings[0], threshold, limit, metric, photo)
  }

  @MeasureExecutionTime
  public async findSimilarTagsToTag(
    tag: Tag,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!tag || !tag.id) {
      throw new Error('Tag no encontrado o no tiene ID asociado')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 't2.embedding <-> t1.embedding AS proximity'
      whereCondition = 't2.embedding <-> t1.embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(t2.embedding <#> t1.embedding) * -1 AS proximity'
      whereCondition = '(t2.embedding <#> t1.embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (t2.embedding <=> t1.embedding) AS proximity'
      whereCondition = '1 - (t2.embedding <=> t1.embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

    const result = await db.rawQuery(
      `
        SELECT t2.id, t2.name, t2."group", t2.created_at, t2.updated_at, ${metricQuery}
        FROM tags t1
        JOIN tags t2 ON t1.id = :id AND t2.id != t1.id
        WHERE ${whereCondition}
        ORDER BY ${orderBy}
        LIMIT :limit
        `,
      {
        id: tag.id,
        threshold,
        limit,
      }
    )

    return result.rows
  }

  // Con photo, saca las proximidades de sus chunks con el termino,
  // sin foto, busca en todos los chunks de descripciones
  @MeasureExecutionTime
  public async findSimilarChunkToEmbedding(
    embedding: number[],
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity',
    photo?: { id: number }
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 'embedding <-> :embedding AS proximity'
      whereCondition = 'embedding <-> :embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
      whereCondition = '(embedding <#> :embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (embedding <=> :embedding) AS proximity'
      whereCondition = '1 - (embedding <=> :embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

    // Añadir filtro por photo_id si se proporciona
    if (photo) {
      whereCondition += ` AND photo_id = :photoId`
    }

    // Formatear el embedding para PostgreSQL (pgvector requiere formato de string: '[value1,value2,...]')
    const embeddingString = `[${embedding.join(',')}]`

    const queryParameters: any = {
      embedding: embeddingString, // Embedding en formato pgvector
      threshold, // Umbral de similitud
      limit, // Número máximo de resultados
    }

    if (photo) {
      queryParameters.photoId = photo.id // Añadir photoId si se proporciona
    }

    const result = await db.rawQuery(
      `
      SELECT id, photo_id, chunk, ${metricQuery}
      FROM descriptions_chunks
      WHERE ${whereCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      queryParameters
    )

    return result.rows
  }

  @MeasureExecutionTime
  public async findSimilarTagToEmbedding(
    embedding: number[],
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!embedding || embedding.length === 0) {
      throw new Error('Embedding no proporcionado o vacío')
    }

    let metricQuery: string = ''
    let whereCondition: string = ''
    let orderBy: string = ''

    if (metric === 'distance') {
      metricQuery = 'embedding <-> :embedding AS proximity'
      whereCondition = 'embedding <-> :embedding <= :threshold'
      orderBy = 'proximity ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(embedding <#> :embedding) * -1 AS proximity'
      whereCondition = '(embedding <#> :embedding) * -1 >= :threshold'
      orderBy = 'proximity DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (embedding <=> :embedding) AS proximity'
      whereCondition = '1 - (embedding <=> :embedding) >= :threshold'
      orderBy = 'proximity DESC'
    }

    // Formatear el embedding para PostgreSQL (pgvector requiere formato de string: '[value1,value2,...]')
    const embeddingString = `[${embedding.join(',')}]`

    const result = await db.rawQuery(
      `
      SELECT id, name, "group", created_at, updated_at, ${metricQuery}
      FROM tags
      WHERE ${whereCondition}
      ORDER BY ${orderBy}
      LIMIT :limit
      `,
      {
        embedding: embeddingString, // Embedding en formato pgvector
        threshold, // Umbral de similitud
        limit, // Número máximo de resultados
      }
    )

    return result.rows
  }

  public async compareGenerality(term: string, texts: string[]) {
    const partitions: string[] = ['creatures', 'objects', 'events']

    // Step 1: Get embedding for the term
    const termEmbedding: any = await this.getEmbedding(term)

    if (!termEmbedding) {
      throw new Error(`Embedding not found for term: ${term}`)
    }

    // Step 2: Determine the closest partition
    const closestPartition = await this.getClosestPartition(termEmbedding, partitions)

    if (!closestPartition) {
      throw new Error(`No suitable partition found for term: ${term}`)
    }

    // Step 3: Calculate the centroid for the closest partition
    const centroid = await this.calculatePartitionCentroid(closestPartition)

    if (!centroid) {
      throw new Error(`Failed to calculate centroid for partition: ${closestPartition}`)
    }

    // Step 4: Compute distances
    const termToCentroidDistance = this.calculateDistance(termEmbedding, centroid)

    const results: any = {}
    for (const text of texts) {
      const textEmbedding = await this.getEmbedding(text)
      if (!textEmbedding) {
        throw new Error(`Embedding not found for text: ${text}`)
      }

      const textToCentroidDistance = this.calculateDistance(textEmbedding, centroid)
      results[text] = textToCentroidDistance // - termToCentroidDistance
      results[term] = termToCentroidDistance
    }

    return Object.fromEntries(Object.entries(results).sort(([, a], [, b]) => b - a))
  }

  private async getEmbedding(name: string): Promise<number[] | string | null> {
    const modelsService = new ModelsService()

    const tag = await Tag.query().where('name', name).first()
    if (tag) {
      return JSON.parse(tag.embedding)
    }

    // Otherwise, fetch dynamically
    const { embeddings } = await modelsService.getEmbeddings([name])
    return embeddings[0] || null
  }

  private async getClosestPartition(
    termEmbedding: number[],
    partitions: string[]
  ): Promise<string | null> {
    const modelsService = new ModelsService()

    let closestPartition = null
    let smallestDistance = Infinity

    for (const partition of partitions) {
      const { embeddings: partitionEmbedding } = await modelsService.getEmbeddings([partition]) // Assume partition names are static
      const distance = this.calculateDistance(termEmbedding, partitionEmbedding[0])
      if (distance < smallestDistance) {
        smallestDistance = distance
        closestPartition = partition
      }
    }

    return closestPartition
  }

  // private async calculatePartitionCentroid(partitionName: string): Promise<number[] | null> {
  //   const result = await db.rawQuery(
  //     `
  //     SELECT vector_avg(embedding) AS centroid
  //     FROM tags
  //     WHERE "group" = :group
  //     `,
  //     { group: `centroid_${partitionName}` }
  //   )

  //   return result.rows[0]?.centroid || null
  // }

  private async calculatePartitionCentroid(partitionName: string): Promise<number[]> {
    // Obtener los embeddings de la partición seleccionada
    const tags = await Tag.query().where('group', `centroid_${partitionName}`).select('embedding')

    if (tags.length === 0) {
      throw new Error(`No se encontraron embeddings para la partición: ${partitionName}`)
    }

    // Verificar que los embeddings sean arrays y convertir si son strings
    const embeddings = tags.map((tag) => {
      if (typeof tag.embedding === 'string') {
        try {
          const parsedEmbedding = JSON.parse(tag.embedding)
          if (Array.isArray(parsedEmbedding)) {
            return parsedEmbedding
          } else {
            throw new Error(`El embedding no es un array válido: ${tag.embedding}`)
          }
        } catch (error) {
          throw new Error(`Error parseando embedding: ${tag.embedding}. ${error.message}`)
        }
      } else if (Array.isArray(tag.embedding)) {
        return tag.embedding
      } else {
        throw new Error(`El formato del embedding no es válido: ${tag.embedding}`)
      }
    })

    // Verificar dimensiones consistentes
    const dimension = embeddings[0].length
    if (!dimension || embeddings.some((emb) => emb.length !== dimension)) {
      throw new Error('Los embeddings tienen dimensiones inconsistentes')
    }

    // Inicializar el centroide con ceros
    const centroid = new Array(dimension).fill(0)

    // Acumular los valores de cada dimensión
    embeddings.forEach((embedding) => {
      for (let i = 0; i < dimension; i++) {
        centroid[i] += embedding[i]
      }
    })

    // Calcular el promedio de cada dimensión
    return centroid.map((sum) => sum / embeddings.length)
  }

  private calculateDistance(vec1: number[], vec2: number[]): number {
    // Use cosine similarity as an example
    const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0)
    const magnitude1 = Math.sqrt(vec1.reduce((sum, val) => sum + val ** 2, 0))
    const magnitude2 = Math.sqrt(vec2.reduce((sum, val) => sum + val ** 2, 0))

    return 1 - dotProduct / (magnitude1 * magnitude2) // Cosine distance
  }

  public async getScoredTagsPhotos(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.2
  ): Promise<{ photo: Photo; tagScore: number }[]> {
    const matchingTags = await this.findSimilarTagsToText(
      description,
      similarityThreshold,
      500, // Limitar la cantidad de tags considerados
      'cosine_similarity'
    )

    const matchingTagMap: Map<string, number> = new Map(
      matchingTags.map((tag: any) => [tag.name, tag.proximity])
    )

    const relevantPhotos = photos.filter((photo) =>
      photo.tags?.some((tag) => matchingTagMap.has(tag.name))
    )

    const results = relevantPhotos.map((photo) => {
      const photoMatchingTags = photo.tags?.filter((tag) => matchingTagMap.has(tag.name)) || []

      // Calcula proximidades relevantes con ponderación exponencial
      const proximities = photoMatchingTags.map((tag) =>
        Math.exp((matchingTagMap.get(tag.name) || 0) - 0.5)
      )

      // Máximo y media ponderada
      const maxProximity = Math.max(...proximities, 0)
      const averageProximity =
        proximities.reduce((sum, proximity) => sum + proximity, 0) / (proximities.length || 1)

      // Score combinado
      const tagScore = 0.75 * maxProximity + 0.25 * averageProximity

      return { photo, tagScore }
    })

    return results.sort((a, b) => b.tagScore - a.tagScore)
  }

  public async getScoredDescPhotos(
    photos: Photo[],
    description: string,
    similarityThreshold: number = 0.12
  ): Promise<{ photo: Photo; descScore: number }[]> {
    const matchingChunks = await this.findSimilarChunksToText(
      description,
      similarityThreshold,
      500, // Limitar la cantidad de chunks considerados
      'cosine_similarity'
    )

    const matchingChunkMap: Map<string | number, number> = new Map(
      matchingChunks.map((chunk: any) => [chunk.id, chunk.proximity])
    )

    const relevantPhotos = photos.filter((photo) =>
      photo.descriptionChunks?.some((chunk) => matchingChunkMap.has(chunk.id))
    )

    const results = relevantPhotos.map((photo) => {
      const photoMatchingChunks =
        photo.descriptionChunks?.filter((chunk) => matchingChunkMap.has(chunk.id)) || []

      // Calcula proximidades relevantes con ponderación exponencial
      const proximities = photoMatchingChunks.map((chunk) =>
        Math.exp((matchingChunkMap.get(chunk.id) || 0) - 0.5)
      )

      // Máximo y media ponderada
      const maxProximity = Math.max(...proximities, 0)
      const averageProximity =
        proximities.reduce((sum, proximity) => sum + proximity, 0) / (proximities.length || 1)

      // Score combinado
      const descScore = 0.75 * maxProximity + 0.25 * averageProximity

      return { photo, descScore }
    })

    return results.sort((a, b) => b.descScore - a.descScore)
  }

  @MeasureExecutionTime
  public async getSemanticScoredPhotos(
    photos: Photo[],
    description: string
  ): Promise<ChunkedPhoto[] | undefined> {
    const weights = {
      tags: 0.6,
      desc: 0.4,
    }

    const [scoredTagsPhotos, scoredDescPhotosChunked] = await Promise.all([
      this.getScoredTagsPhotos(photos, description),
      this.getScoredDescPhotos(photos, description),
    ])

    const tagScoresMap = new Map(scoredTagsPhotos.map((item) => [item.photo.id, item.tagScore]))
    const descScoresMap = new Map(
      scoredDescPhotosChunked.map((item) => [item.photo.id, item.descScore])
    )

    const scoredPhotos: ChunkedPhoto[] = photos.map((photo) => {
      const tagScore = tagScoresMap.get(photo.id) || 0
      const descScore = descScoresMap.get(photo.id) || 0

      return {
        photo,
        tagScore,
        descScore,
        totalScore: tagScore * weights.tags + descScore * weights.desc,
      }
    })

    const filteredAndSortedPhotos: ChunkedPhoto[] = scoredPhotos
      .filter((photo) => photo.totalScore > 0.05)
      .sort((a, b) => b.totalScore - a.totalScore)

    return filteredAndSortedPhotos
  }

  private async chunkDescriptions(
    photos: any[],
    description: string,
    similarityThresholdDesc: number = 15
  ): Promise<any[]> {
    const modelsService = new ModelsService()

    const promises = photos.map(async (photo: Photo) => {
      if (!photo.description) return null

      // Obtener proximidades de los chunks
      const chunkProximities = await modelsService.semanticProximitChunks(
        description,
        photo.description,
        description.length * 8
      )

      // Filtrar chunks por umbral de proximidad y ordenarlos
      const selectedChunks = chunkProximities
        .filter(({ proximity }: any) => proximity >= similarityThresholdDesc / 100)
        .sort((a: any, b: any) => b.proximity - a.proximity)

      return {
        ...photo,
        chunks: selectedChunks.map(({ text_chunk }: any) => text_chunk),
      }
    })

    // Esperar a que todas las promesas se resuelvan
    return Promise.all(promises)
  }

  /////////////////////////////////

  private projectOntoDirection(termEmbedding: number[], direction: number[]): number {
    const dotProduct = termEmbedding.reduce((sum, val, i) => sum + val * direction[i], 0)
    const directionMagnitude = Math.sqrt(direction.reduce((sum, val) => sum + val ** 2, 0))

    return dotProduct / directionMagnitude // Proyección escalar
  }

  private async calculateGeneralityDirection(partitionTerms: string[]): Promise<number[]> {
    const embeddings = await Promise.all(partitionTerms.map((term) => this.getEmbedding(term)))

    // Asegurarnos de que no haya valores nulos
    if (embeddings.some((e) => !e)) {
      throw new Error('Error obteniendo embeddings para términos de la partición.')
    }

    // Dirección de generalidad: más general - más específico
    const generalEmbedding = embeddings[embeddings.length - 1]
    const specificEmbedding = embeddings[0]

    return generalEmbedding.map((val, i) => val - specificEmbedding[i])
  }

  private async determinePartition(
    term: string,
    partitions: Record<string, string[]>
  ): Promise<string> {
    const termEmbedding = await this.getEmbedding(term)
    if (!termEmbedding) {
      throw new Error(`No se encontró embedding para el término: ${term}`)
    }

    let closestPartition = ''
    let highestSimilarity = -Infinity

    for (const [partitionKey, partitionTerms] of Object.entries(partitions)) {
      const keyEmbedding = await this.getEmbedding(partitionKey)
      if (!keyEmbedding) {
        throw new Error(`No se encontró embedding para la clave de partición: ${partitionKey}`)
      }

      const similarity = this.projectOntoDirection(termEmbedding, keyEmbedding)
      if (similarity > highestSimilarity) {
        highestSimilarity = similarity
        closestPartition = partitionKey
      }
    }

    return closestPartition
  }

  public async compareGeneralityWithDirection(
    term: string,
    texts: string[]
  ): Promise<Record<string, number>> {
    // Determinar la partición más cercana
    const closestPartition = await this.determinePartition(term, partitions)
    const partitionTerms = partitions[closestPartition]

    // Calcular la dirección de generalidad
    const direction = await this.calculateGeneralityDirection(partitionTerms)

    // Obtener embedding del término principal
    const termEmbedding = await this.getEmbedding(term)
    if (!termEmbedding) {
      throw new Error(`No se encontró embedding para el término: ${term}`)
    }

    // Proyectar término principal en la dirección
    const termProjection = this.projectOntoDirection(termEmbedding, direction)

    // Evaluar cada texto
    const results: Record<string, number> = {}
    for (const text of texts) {
      const textEmbedding = await this.getEmbedding(text)
      if (!textEmbedding) {
        throw new Error(`No se encontró embedding para el texto: ${text}`)
      }

      const textProjection = this.projectOntoDirection(textEmbedding, direction)
      results[text] = textProjection
      results[term] = termProjection
    }

    return Object.fromEntries(Object.entries(results).sort(([, a], [, b]) => b - a))
  }
}
