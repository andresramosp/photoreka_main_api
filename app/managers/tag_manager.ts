import Tag, { TagGroups } from '#models/tag'
import VectorService from '#services/vector_service'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { withCache } from '../decorators/withCache.js'
import Logger from '../utils/logger.js'

const logger = Logger.getInstance('AnalyzerService')

export default class TagManager {
  constructor() {}

  // Crea un nuevo Tag
  public async createTag(data: Partial<Tag>): Promise<Tag> {
    const tag = await Tag.create(data)
    return tag
  }

  // Obtiene un Tag por su ID
  public async getTagById(id: string): Promise<Tag> {
    const tag = await Tag.find(id)
    if (!tag) {
      throw new Error('Tag not found')
    }
    return tag
  }

  public async getTagByNameAndGroup(name: string, group: TagGroups): Promise<Tag | null> {
    return Tag.query().where('name', name).andWhere('group', group).first()
  }

  // Obtiene todos los Tags
  @withCache({
    key: (userId) => `getTagsByUser_${userId}`,
    provider: 'redis',
    ttl: 60 * 5,
  })
  public async getTagsByUser(userId: string): Promise<Tag[]> {
    // Busca los tags asociados a las fotos del usuario, sin duplicados
    const tags = await Tag.query()
      .join('tags_photos', 'tags_photos.tag_id', 'tags.id')
      .join('photos', 'photos.id', 'tags_photos.photo_id')
      .where('photos.user_id', userId)
      .distinct('tags.id')
      .select('tags.*')
    return tags
  }

  // Actualiza un Tag existente
  public async updateTag(id: string, data: Partial<Tag>): Promise<Tag> {
    const tag = await Tag.find(id)
    if (!tag) {
      throw new Error('Tag not found')
    }
    Object.assign(tag, data)
    await tag.save()
    return tag
  }

  // Elimina un Tag por su ID
  public async deleteTag(id: string): Promise<{ message: string }> {
    const tag = await Tag.find(id)
    if (!tag) {
      throw new Error('Tag not found')
    }
    await tag.delete()
    return { message: 'Tag deleted successfully' }
  }

  // @MeasureExecutionTime
  public async getOrCreateSimilarTag(
    tag: Partial<Tag> & { name: string; group: TagGroups },
    embedding: number[]
  ): Promise<Tag> {
    // logger.debug(`Buscando tag: ${tag.name} (${tag.group})`)
    const vectorService = new VectorService()

    // 1. Buscar tag exacto
    const existingTag = await this.getTagByNameAndGroup(tag.name, tag.group)
    if (existingTag) {
      logger.debug(`Tag exacto encontrado: ${existingTag.name} (ID: ${existingTag.id})`)
      return existingTag
    }

    // 2. Buscar tags similares
    let similarTagsResult: any[] = []
    try {
      logger.debug(`Buscando tags similares para: ${tag.name}`)
      similarTagsResult = (await vectorService.findSimilarTagToEmbedding(embedding, 0.89, 5)) || []
      // logger.debug(`Resultados de búsqueda similar:`, similarTagsResult)
    } catch (error) {
      logger.error(`Error al buscar tags similares:`, error)
      // No lanzamos el error, continuamos con la creación de nuevo tag
    }

    if (similarTagsResult.length > 0) {
      const similarTag = similarTagsResult[0]
      if (!similarTag.tag_id) {
        // logger.error(`Tag similar encontrado pero sin tag_id:`, similarTag)
        // Si no tiene tag_id, continuamos con la creación de nuevo tag
      } else {
        similarTag.id = similarTag.tag_id
        logger.debug(`Usando tag similar: ${similarTag.name} (ID: ${similarTag.id})`)
        return similarTag
      }
    }

    // 3. Crear nuevo tag
    try {
      logger.debug(`Creando nuevo tag: ${tag.name} (${tag.group})`)
      const newTag = new Tag()
      newTag.name = tag.name
      newTag.group = tag.group
      // El hook @beforeSave se encargará de formatear el embedding
      newTag.embedding = embedding
      await newTag.save()
      logger.debug(`Nuevo tag creado exitosamente: ${newTag.name} (ID: ${newTag.id})`)
      return newTag
    } catch (err: any) {
      if (err.code === '23505') {
        logger.debug(`Tag ${tag.name} ya existe, buscando nuevamente...`)
        const concurrentTag = await this.getTagByNameAndGroup(tag.name, tag.group)
        if (concurrentTag) {
          logger.debug(
            `Tag concurrente encontrado: ${concurrentTag.name} (ID: ${concurrentTag.id})`
          )
          return concurrentTag
        }
      }
      logger.error(`Error al crear tag ${tag.name}:`)
      throw new Error(`No se pudo crear o recuperar el tag: ${tag.name}. Error: ${err.message}`)
    }
  }
}
