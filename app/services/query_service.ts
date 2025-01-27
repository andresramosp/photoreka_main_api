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

  public async processQuery(searchType: 'semantic' | 'creative', query) {
    const enrichmentMessage = SYSTEM_MESSAGE_QUERY_ENRICHMENT
    const sourceMessage = SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE

    // Ejecutamos las llamadas en paralelo
    const [enrichmentResponse, sourceResponse] = await Promise.all([
      this.modelsService.getDSResponse(
        enrichmentMessage,
        JSON.stringify({ query: query.description })
      ),
      this.modelsService.getDSResponse(sourceMessage, JSON.stringify({ query: query.description })),
    ])

    const { result: enrichmentResult, cost: cost1 } = enrichmentResponse
    const { result: sourceResult, cost: cost2 } = sourceResponse

    let useImage = sourceResult.requireSource == 'image'
    if (useImage) {
      console.log()
    }

    let searchModelMessage

    if (searchType === 'semantic') {
      if (!useImage) {
        if (enrichmentResult.type === 'logical') {
          searchModelMessage = SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL_v2(true)
        } else {
          searchModelMessage = SYSTEM_MESSAGE_SEARCH_SEMANTIC(true)
        }
      } else {
        searchModelMessage = SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE
      }
    } else if (searchType === 'creative') {
      if (!useImage) {
        searchModelMessage = SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
      } else {
        searchModelMessage = SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
      }
    }

    console.log(
      `[processQuery]: Result for ${query.description} -> ${JSON.stringify(enrichmentResult)}`
    )

    return {
      searchModelMessage,
      sourceResult,
      useImage,
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

    if (photo.id == '884b1f43-e678-4dbf-b788-48b05c945e61') {
      console.log()
    }

    for (let { term, operator } of termsWithOperators) {
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
    const segments = query.split(/\b(AND|OR|NOT)\b/).map((s) => s.trim())
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
