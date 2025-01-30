// @ts-nocheck

import {
  SYSTEM_MESSAGE_QUERY_ENRICHMENT,
  SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE,
  SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE,
  SYSTEM_MESSAGE_SEARCH_SEMANTIC,
  SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL_v2,
} from '../utils/ModelsMessages.js'
import AnalyzerService from './analyzer_service.js'
import EmbeddingsService from './embeddings_service.js'
import ModelsService from './models_service.js'

export default class QueryService {
  public modelsService: ModelsService = null
  public embeddingsService: EmbeddingsService = null
  public analyzerService: AnalyzerService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.embeddingsService = new EmbeddingsService()
    this.analyzerService = new AnalyzerService()
  }

  public async processQuery(searchType: 'logical' | 'semantic' | 'creative', query) {
    const enrichmentMessage = SYSTEM_MESSAGE_QUERY_ENRICHMENT
    const sourceMessage = SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE

    // Ejecutamos las llamadas en paralelo, omitiendo la llamada a sourceMessage si searchType es 'logical'
    const enrichmentPromise = this.modelsService.getGPTResponse(
      enrichmentMessage,
      JSON.stringify({ query: query.description })
    )

    let enrichmentResponse, sourceResponse

    if (searchType === 'logical') {
      enrichmentResponse = await enrichmentPromise
      sourceResponse = { result: { requireSource: null, cost: 0 } } // Simulamos una respuesta vacía para evitar errores
    } else {
      ;[enrichmentResponse, sourceResponse] = await Promise.all([
        enrichmentPromise,
        this.modelsService.getGPTResponse(
          sourceMessage,
          JSON.stringify({ query: query.description })
        ),
      ])
    }

    let { result: enrichmentResult, cost: cost1 } = enrichmentResponse
    let { result: sourceResult, cost: cost2 } = sourceResponse

    enrichmentResult.original = query.description

    sourceResult.requireSource = 'description'

    let searchModelMessage

    if (searchType === 'logical') {
      searchModelMessage = SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL_v2(true)
    } else if (searchType === 'semantic') {
      searchModelMessage =
        sourceResult.requireSource === 'description'
          ? SYSTEM_MESSAGE_SEARCH_SEMANTIC(true)
          : SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE
    } else {
      searchModelMessage =
        sourceResult.requireSource === 'image'
          ? SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
          : SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
    }

    console.log(
      `[processQuery]: Result for ${query.description} -> ${JSON.stringify(enrichmentResult)}`
    )

    return {
      searchModelMessage,
      sourceResult,
      enrichmentResult,
      cost1,
      cost2,
    }
  }

  public async evaluateQueryLogic(query, photo) {
    const segments = query.split(/\s+(AND|NOT)\s+/i).filter(Boolean) // Split into terms and operators
    const termsWithOperators = []

    // Parse terms and associate them with their operators
    let currentOperator = 'AND'
    for (let segment of segments) {
      if (segment.toUpperCase() === 'AND' || segment.toUpperCase() === 'NOT') {
        currentOperator = segment.toUpperCase()
      } else {
        termsWithOperators.push({ term: segment.trim(), operator: currentOperator })
      }
    }

    let allMatched = true
    let hasNotMatched = false

    for (let { term, operator } of termsWithOperators) {
      if (photo.id == '38371661-b2b9-4e09-9809-ddc490f4239f') {
        console.log()
      }

      let { matchingTags, method, lematizedTerm } =
        await this.embeddingsService.findMatchingTagsForTerm(term, photo.tags, 0.85, 5)

      if (matchingTags.length > 0) {
        console.log(
          `[evaluateQueryLogic]: Found matching tags for '${term}' [${lematizedTerm}] -> '${matchingTags.map((mt) => mt.name)}' by ${method} `
        )
        if (operator === 'NOT') {
          hasNotMatched = true
        }
      } else {
        return null
      }
    }

    if (hasNotMatched) {
      return false
    }

    return allMatched
  }

  public async getTagsForLogicalQuery(
    photo,
    query,
    similarityThreshold: number = 0.2,
    limitPerSegment: number = 8
  ) {
    // Dividir la consulta en segmentos separados por operadores
    const isSimpleDescription = !query.includes('|')
    const segments = isSimpleDescription
      ? query.split(/\b(AND|OR|NOT)\b/).map((s) => s.trim())
      : query.split('|').map((segment) => segment.trim())
    const tagsSet = new Set<any>() // Usar un Set para evitar duplicados
    const promises: Promise<any>[] = []

    for (const segment of segments) {
      // Ignorar los operadores
      if (['AND', 'OR', 'NOT'].includes(segment)) {
        continue
      }

      // Procesar el segmento completo (incluyendo términos separados por comas)
      promises.push(
        (async () => {
          const { embeddings } = await this.modelsService.getEmbeddings([segment])
          const similarTags = await this.embeddingsService.findSimilarTagToEmbedding(
            embeddings[0],
            similarityThreshold,
            limitPerSegment,
            'cosine_similarity',
            photo.tags.map((tag) => tag.id)
          )
          similarTags.forEach((tag) => tagsSet.add(tag)) // Agregar tags al Set
          console.log(`Similar tags to ${segment}: ${similarTags.map((t) => t.name)}`)
        })()
      )
    }

    // Esperar a que se completen todas las promesas
    await Promise.all(promises)

    return [...tagsSet] // Devolver el Set como un array
  }
}
