import { pipeline } from '@xenova/transformers'
import { withCache } from '../decorators/withCache.js'

class EmbeddingService {
  private extractor: any | null = null

  private async loadModel() {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    }
  }

  @withCache({
    provider: 'redis',
    ttl: 60 * 60,
  })
  public async generateEmbeddings(sentences: string[]): Promise<number[][]> {
    await this.loadModel()

    const embeddingPromises = sentences.map((sentence) =>
      this.extractor(sentence, { pooling: 'mean', normalize: false })
    )

    const results = await Promise.all(embeddingPromises)

    // Aquí forzamos la conversión a array real
    return results.map((r) => Array.from(r.data))
  }
}

export default new EmbeddingService()
