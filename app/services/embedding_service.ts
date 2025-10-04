// NOTA: No importamos directamente '@xenova/transformers' para evitar que se carguen
// dependencias nativas (como 'sharp') cuando solo usamos funciones ligeras
// (generateArtisticScoresEmbedding) desde modelos.
// Se hace import dinámico dentro de loadModel().
import { withCache } from '../decorators/withCache.js'

class EmbeddingService {
  private extractor: any | null = null

  // Orden canónico de dimensiones para artistic_scores
  private artisticScoresOrder = [
    'humor',
    'message',
    'candidness',
    'composition',
    'strangeness',
    'storytelling',
    'visual_games',
    'aesthetic_quality',
  ] as const

  // Diccionario de valores posibles para cada campo de visual_aspects
  // Cada valor se codifica como su índice en el array (one-hot style)
  private visualAspectsSchema = {
    focus: ['blurry', 'nitid'],
    lighting_scheme: ['low key', 'high key', 'balanced'],
    stylistic: ['long exposure', 'motion blur', 'silhouettes', 'bokeh', 'grain'],
    lighting: ['natural', 'artificial', 'backlit', 'frontlit', 'side lit'],
    depth_of_field: ['shallow', 'deep', 'medium'],
    framing: ['close-up', 'medium shot', 'wide shot'],
    genre: ['abstract', 'documentary', 'street', 'landscape', 'portrait'],
    perspective: ['normal', 'high angle', 'low angle'],
    palette: ['color', 'black and white', 'monochrome'],
    temperature: ['warm', 'cool', 'neutral'],
    orientation: ['horizontal', 'vertical', 'square'],
  } as const

  // Orden de campos para el embedding
  private visualAspectsFieldsOrder = [
    'focus',
    'lighting_scheme',
    'stylistic',
    'lighting',
    'depth_of_field',
    'framing',
    'genre',
    'perspective',
    'palette',
    'temperature',
    'orientation',
  ] as const

  /**
   * Genera vector normalizado (div /10) a partir de objeto artistic_scores.
   * Si falta alguna clave se rellena con 0.
   */
  public generateArtisticScoresEmbedding(
    scores: Record<string, any> | null | undefined
  ): number[] | null {
    if (!scores) return null
    const vec = this.artisticScoresOrder.map((k) => {
      const raw = scores[k as string]
      if (raw == null || isNaN(raw)) return 0
      const v = Number(raw)
      // Asumimos escala 0-10 -> normalizamos a 0-1
      const normalized = Math.max(0, Math.min(10, v)) / 10
      return Number(normalized.toFixed(6))
    })
    return vec
  }

  /**
   * Genera vector determinístico a partir de objeto visual_aspects.
   * Codifica cada campo con normalización suave basada en frecuencia relativa.
   * Si hay múltiples valores, cada uno contribuye proporcionalmente (suma = 1).
   * Si falta alguna clave se rellena con 0s.
   */
  public generateVisualAspectsEmbedding(
    aspects: Record<string, any> | null | undefined
  ): number[] | null {
    if (!aspects) return null

    const vec: number[] = []

    for (const field of this.visualAspectsFieldsOrder) {
      const possibleValues = this.visualAspectsSchema[field] as readonly string[]
      const actualValues = aspects[field]

      // Normalizar valores por frecuencia para crear gradientes suaves
      let normalizedWeight = 1
      let activeValues: string[] = []

      if (Array.isArray(actualValues)) {
        activeValues = actualValues.filter((v) => (possibleValues as readonly string[]).includes(v))
        normalizedWeight = activeValues.length > 0 ? 1 / activeValues.length : 0
      } else if (actualValues && (possibleValues as readonly string[]).includes(actualValues)) {
        activeValues = [actualValues]
        normalizedWeight = 1
      }

      // Asignar peso normalizado a cada valor presente
      for (const possibleValue of possibleValues) {
        const hasValue = activeValues.includes(possibleValue) ? normalizedWeight : 0
        vec.push(Number(hasValue.toFixed(6)))
      }
    }

    return vec
  }

  /**
   * Normaliza y asigna embedding a instancia Photo (en memoria). No persiste.
   */
  public fillPhotoArtisticScoresEmbedding(photo: any) {
    try {
      const scores = photo.descriptions?.artistic_scores
      const vec = this.generateArtisticScoresEmbedding(scores)
      if (vec) {
        photo.artisticScoresEmbedding = vec
      }
    } catch (err) {
      // Silencioso por ahora; en futuro se puede loggear
    }
  }

  private async loadModel() {
    if (!this.extractor) {
      const { pipeline } = await import('@xenova/transformers')
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
