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
  public async getAllTags(): Promise<Tag[]> {
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
    const embeddingsService = new EmbeddingsService()

    const existingTag = await this.getTagByNameAndGroup(tag.name, tag.group)
    if (existingTag) {
      console.log(`Using existing exact tag for ${tag.name}: ${existingTag.name}`)
      return existingTag
    }

    // Busca etiquetas similares.
    let similarTagsResult: any[] = []
    try {
      similarTagsResult = (await embeddingsService.findSimilarTagsToText(tag.name, 0.89, 5)) || []
    } catch (error) {
      console.log('Error in findSimilarTagsToText')
    }
    // TODO: asegurarse de que el primero es el mejor, ¿por qué devolviamos varios?
    if (similarTagsResult.length > 0) {
      const similarTag = similarTagsResult[0] as Tag
      console.log(`Using existing similar tags for ${tag.name}: ${similarTag.name}`)
      return similarTag
    }

    // Si no se encontró etiqueta existente ni similar, se intenta guardar la nueva.
    try {
      await tag.save()
      return tag
    } catch (err: any) {
      if (err.code === '23505') {
        console.log(
          `Tried to save tag (${tag.name}) already existing in BD, fetching existing one.`
        )
        const concurrentTag = await this.getTagByNameAndGroup(tag.name, tag.group)
        if (concurrentTag) return concurrentTag
      } else {
        throw err
      }
    }
    throw new Error(`Could not create or retrieve tag: ${tag.name}`)
  }
}
