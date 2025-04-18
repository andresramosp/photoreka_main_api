import Tag, { TagGroups } from '#models/tag'
import EmbeddingsService from '#services/embeddings_service'

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
  public async getTagsByUser(userId: string): Promise<Tag[]> {
    const tags = await Tag.all()
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

  public async getOrCreateSimilarTag(
    tag: Partial<Tag> & { name: string; group: TagGroups }
  ): Promise<Tag> {
    console.log(`[TagManager] Buscando tag: ${tag.name} (${tag.group})`)
    const embeddingsService = new EmbeddingsService()

    // 1. Buscar tag exacto
    const existingTag = await this.getTagByNameAndGroup(tag.name, tag.group)
    if (existingTag) {
      console.log(`[TagManager] Tag exacto encontrado: ${existingTag.name} (ID: ${existingTag.id})`)
      return existingTag
    }

    // 2. Buscar tags similares
    let similarTagsResult: any[] = []
    try {
      console.log(`[TagManager] Buscando tags similares para: ${tag.name}`)
      similarTagsResult = (await embeddingsService.findSimilarTagsToText(tag.name, 0.89, 5)) || []
      console.log(
        `[TagManager] Resultados de búsqueda similar:`,
        JSON.stringify(similarTagsResult, null, 2)
      )
    } catch (error) {
      console.error(`[TagManager] Error al buscar tags similares:`, error)
      // No lanzamos el error, continuamos con la creación de nuevo tag
    }

    if (similarTagsResult.length > 0) {
      const similarTag = similarTagsResult[0]
      if (!similarTag.tag_id) {
        console.error(`[TagManager] Tag similar encontrado pero sin tag_id:`, similarTag)
        // Si no tiene tag_id, continuamos con la creación de nuevo tag
      } else {
        similarTag.id = similarTag.tag_id
        console.log(`[TagManager] Usando tag similar: ${similarTag.name} (ID: ${similarTag.id})`)
        return similarTag
      }
    }

    // 3. Crear nuevo tag
    try {
      console.log(`[TagManager] Creando nuevo tag: ${tag.name} (${tag.group})`)
      const newTag = new Tag()
      newTag.name = tag.name
      newTag.group = tag.group
      await newTag.save()
      console.log(`[TagManager] Nuevo tag creado exitosamente: ${newTag.name} (ID: ${newTag.id})`)
      return newTag
    } catch (err: any) {
      if (err.code === '23505') {
        console.log(`[TagManager] Tag ${tag.name} ya existe, buscando nuevamente...`)
        const concurrentTag = await this.getTagByNameAndGroup(tag.name, tag.group)
        if (concurrentTag) {
          console.log(
            `[TagManager] Tag concurrente encontrado: ${concurrentTag.name} (ID: ${concurrentTag.id})`
          )
          return concurrentTag
        }
      }
      console.error(`[TagManager] Error al crear tag ${tag.name}:`, err)
      throw new Error(`No se pudo crear o recuperar el tag: ${tag.name}. Error: ${err.message}`)
    }
  }
}
