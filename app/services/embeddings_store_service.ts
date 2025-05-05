import ModelsService from './models_service.js'
import NLPService from './nlp_service.js'

export class EmbeddingStoreService {
  private static embeddingsMap: Record<string, number[]> = {}

  public static addEmbeddings(pairs: { key: string; value: number[] }[]): void {
    for (const { key, value } of pairs) {
      this.embeddingsMap[key] = value
      console.log(
        `[EmbeddingStoreService] Embedding almacenado para clave '${key}' (dimensión: ${value.length})`
      )
    }
  }

  public static getEmbedding(key: string): number[] | null {
    const found = this.embeddingsMap[key]
    if (found) {
      console.log(`[EmbeddingStoreService] Recuperado embedding para clave '${key}'`)
      return found
    } else {
      console.warn(`[EmbeddingStoreService] No se encontró embedding para la clave '${key}'`)
      return null
    }
  }

  public static getAllKeys(): string[] {
    const keys = Object.keys(this.embeddingsMap)
    console.log(`[EmbeddingStoreService] Claves almacenadas: [${keys.join(', ')}]`)
    return keys
  }

  public static clearEmbedding(key: string): void {
    if (this.embeddingsMap[key]) {
      delete this.embeddingsMap[key]
      console.log(`[EmbeddingStoreService] Embedding para la clave '${key}' eliminado`)
    } else {
      console.warn(`[EmbeddingStoreService] No hay embedding para eliminar en la clave '${key}'`)
    }
  }

  public static clearAll(): void {
    this.embeddingsMap = {}
    console.log(`[EmbeddingStoreService] Todos los embeddings han sido eliminados`)
  }

  public static async calculateEmbeddings(terms: string[]): Promise<void> {
    const newTerms = terms.filter((term) => !this.embeddingsMap[term])

    if (newTerms.length === 0) {
      console.log(
        `[EmbeddingStoreService] Todos los términos ya tienen embeddings almacenados. Nada que calcular.`
      )
      return
    }

    console.log(
      `[EmbeddingStoreService] Calculando embeddings para ${newTerms.length} nuevos términos...`
    )

    const modelsService = new ModelsService()
    const { embeddings } = await modelsService.getEmbeddings(newTerms)

    if (!embeddings || embeddings.length !== newTerms.length) {
      throw new Error(
        `[EmbeddingStoreService] Error: Mismatch entre entrada (${newTerms.length}) y embeddings devueltos (${embeddings?.length})`
      )
    }

    const pairs = newTerms.map((key, index) => ({
      key,
      value: embeddings[index],
    }))

    this.addEmbeddings(pairs)

    console.log(
      `[EmbeddingStoreService] Embeddings calculados y almacenados para claves: [${newTerms.join(
        ', '
      )}]`
    )
  }
}
