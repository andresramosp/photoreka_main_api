import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'

export default class TagsService {
  public async findSimilarTagsToText(
    term: string,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    const modelsService = new ModelsService()

    let existingTag = await Tag.query().where('name', term).andWhereNotNull('embedding').first()
    if (existingTag) {
      return this.findSimilarTagsToTag(existingTag, threshold, limit, metric)
    } else {
      let { embeddings } = await modelsService.getEmbeddings([term])
      return this.findSimilarTagToEmbedding(embeddings[0], threshold, limit, metric)
    }
  }

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
      //   `
      //   SELECT t2.id, t2.name, t2."group", t2.created_at, t2.updated_at, ${metricQuery}
      //   FROM tags t1
      //   JOIN tags t2 ON t1.id = :id AND t2.id != t1.id
      //   WHERE ${whereCondition}
      //   ORDER BY ${orderBy}
      //   LIMIT :limit
      //   `,
      ` SELECT DISTINCT ON (t2.name) 
         t2.id, t2.name, t2."group", t2.created_at, t2.updated_at, ${metricQuery}
        FROM tags t1
        JOIN tags t2 ON t1.id = :id AND t2.id != t1.id
        WHERE ${whereCondition}
        ORDER BY t2.name, ${orderBy} -- Primero agrupa por t2.name, luego aplica el orden adicional
        LIMIT :limit`,
      {
        id: tag.id,
        threshold,
        limit,
      }
    )

    return result.rows
  }

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
}
