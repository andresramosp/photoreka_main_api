// @ts-nocheck

import { withCache } from '../decorators/withCache.js'
import withCost from '../decorators/withCost.js'
import {
  SYSTEM_MESSAGE_CULTURAL_ENRICHMENT,
  SYSTEM_MESSAGE_QUERY_ENRICHMENT,
  SYSTEM_MESSAGE_QUERY_ENRICHMENT_CREATIVE,
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

  // Parece que no es estrictamente necesaria la expansión, cuando se consideran los neutrals (strictInference = false)
  // Pero sí que habría que distinguir cuando una query contiene una referencia o el prefijo evocativo para establecer ese valor
  // withCost()
  // TODO: userid!!
  @withCache({
    key: (arg1, arg2) => `${arg1}_${arg2.description}`,
    provider: 'redis',
    ttl: 60 * 10,
  })
  public async structureQuery(searchType: 'logical' | 'semantic' | 'creative', query) {
    let expansionCost = 0
    let structuredResult = await this.modelsService.getStructuredQuery(query.description)
    let sourceResult = { requireSource: 'description' }

    let searchModelMessage
    if (searchType === 'creative' || searchType === 'semantic') {
      searchModelMessage =
        sourceResult.requireSource === 'image'
          ? SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
          : SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
    }

    console.log(
      `[processQuery]: Result for ${query.description} -> ${JSON.stringify(structuredResult.positive_segments)}`
    )

    return {
      searchModelMessage,
      sourceResult,
      structuredResult,
      expansionCost,
    }
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
          if (photo.id == 'f6096759-8ec6-4e08-888a-b39e83e05c69') {
            console.log()
          }
          similarTags.forEach((tag) => tagsSet.add(tag)) // Agregar tags al Set
          console.log(`Similar tags to ${segment}: ${similarTags.map((t) => t.name)}`)
        })()
      )
    }

    // Esperar a que se completen todas las promesas
    await Promise.all(promises)

    return [...tagsSet] // Devolver el Set como un array
  }

  // desuso
  public async evaluateQueryLogic(query, photo) {
    const segments = query.split(/\s+(AND|OR|NOT|\|)\s+/i).filter(Boolean) // Split into terms and operators
    const termsWithOperators = []

    let currentOperator = 'AND'
    for (let segment of segments) {
      if (['AND', 'OR', 'NOT', '|'].includes(segment.toUpperCase())) {
        currentOperator = segment.toUpperCase() === '|' ? 'AND' : segment.toUpperCase()
      } else {
        termsWithOperators.push({ term: segment.trim(), operator: currentOperator })
      }
    }

    let allMatched = true
    let hasNotMatched = false
    let hasOrMatch = false

    for (let { term, operator } of termsWithOperators) {
      let { matchingTags, method, lematizedTerm } =
        await this.embeddingsService.findMatchingTagsForTerm(term, photo.tags, 0.85, 5)

      if (matchingTags.length > 0) {
        console.log(
          `[evaluateQueryLogic]: Found matching tags for '${term}' [${lematizedTerm}] -> '${matchingTags.map((mt) => mt.name)}' by ${method} `
        )

        if (operator === 'NOT') {
          hasNotMatched = true
        } else if (operator === 'OR') {
          hasOrMatch = true
        }
      } else {
        if (operator === 'AND') {
          return null
        }
      }
    }

    if (hasNotMatched) {
      return false
    }

    return hasOrMatch || allMatched
  }

  // desuso
  // public async processQuery(searchType: 'logical' | 'semantic' | 'creative', query) {
  //   const enrichmentMessage =
  //     searchType !== 'creative'
  //       ? SYSTEM_MESSAGE_QUERY_ENRICHMENT
  //       : SYSTEM_MESSAGE_QUERY_ENRICHMENT_CREATIVE
  //   const sourceMessage = SYSTEM_MESSAGE_QUERY_REQUIRE_SOURCE

  //   // Ejecutamos las llamadas en paralelo, omitiendo la llamada a sourceMessage si searchType es 'logical'
  //   const enrichmentPromise = this.modelsService.getGPTResponse(
  //     enrichmentMessage,
  //     JSON.stringify({ query: query.description }),
  //     'gpt-4o-mini'
  //   )

  //   let enrichmentResponse, sourceResponse

  //   if (true) {
  //     // (searchType === 'logical') {
  //     enrichmentResponse = await enrichmentPromise
  //     sourceResponse = { result: { requireSource: null, cost: 0 } } // Simulamos una respuesta vacía para evitar errores
  //   } else {
  //     ;[enrichmentResponse, sourceResponse] = await Promise.all([
  //       enrichmentPromise,
  //       this.modelsService.getGPTResponse(
  //         sourceMessage,
  //         JSON.stringify({ query: query.description })
  //       ),
  //     ])
  //   }

  //   let { result: enrichmentResult, cost: cost1 } = enrichmentResponse
  //   let { result: sourceResult, cost: cost2 } = sourceResponse

  //   enrichmentResult.original = query.description

  //   sourceResult.requireSource = 'description'

  //   let searchModelMessage

  //   if (searchType === 'logical') {
  //     searchModelMessage = SYSTEM_MESSAGE_SEARCH_SEMANTIC_LOGICAL_v2(true)
  //   } else if (searchType === 'semantic') {
  //     searchModelMessage =
  //       sourceResult.requireSource === 'description'
  //         ? SYSTEM_MESSAGE_SEARCH_SEMANTIC(true)
  //         : SYSTEM_MESSAGE_SEARCH_MODEL_ONLY_IMAGE
  //   } else {
  //     searchModelMessage =
  //       sourceResult.requireSource === 'image'
  //         ? SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE_ONLY_IMAGE
  //         : SYSTEM_MESSAGE_SEARCH_MODEL_CREATIVE(true)
  //   }

  //   console.log(
  //     `[processQuery]: Result for ${query.description} -> ${JSON.stringify(enrichmentResult)}`
  //   )

  //   return {
  //     searchModelMessage,
  //     sourceResult,
  //     enrichmentResult,
  //     cost1,
  //     cost2,
  //   }
  // }
}
