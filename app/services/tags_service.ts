import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'
import ModelsService from './models_service.js'

export default class TagsService {
  public async findSimilarTagsToText(term: string) {
    const modelsService = new ModelsService()

    let existingTag = await Tag.query().where('name', term).first()
    if (existingTag) {
      return this.findSimilarTagsToTag(existingTag)
    } else {
      let { embeddings } = await modelsService.getEmbeddings([term])
      return this.findSimilarTagToEmbedding(embeddings[0])
    }
  }

  public async findSimilarTagsToTag(
    tag: Tag,
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    if (!tag || !tag.embedding) {
      throw new Error('Tag no encontrado o no tiene embedding asociado')
    }

    let metricQuery: string = ''
    let orderBy: string = ''
    if (metric === 'distance') {
      metricQuery = 'embedding <-> $1 AS distance'
      orderBy = 'distance ASC'
    } else if (metric === 'inner_product') {
      metricQuery = '(embedding <#> $1) * -1 AS inner_product'
      orderBy = 'inner_product DESC'
    } else if (metric === 'cosine_similarity') {
      metricQuery = '1 - (embedding <=> $1) AS cosine_similarity'
      orderBy = 'cosine_similarity DESC'
    }

    const result = await db.rawQuery(
      `
          SELECT id, name, group, embedding, created_at, updated_at, ${metricQuery}
          FROM tags
          WHERE id != $2
            AND embedding <-> $1 <= $3 -- Puedes ajustar este filtro para métricas específicas
          ORDER BY ${orderBy}
          LIMIT $4
          `,
      [tag.embedding, tag.id, threshold, limit]
    )

    return result.rows
  }

  public async findSimilarTagToEmbedding(
    embedding: number[],
    threshold: number = 0.3,
    limit: number = 10,
    metric: 'distance' | 'inner_product' | 'cosine_similarity' = 'cosine_similarity'
  ) {
    // Tarea para GPT
  }
}
