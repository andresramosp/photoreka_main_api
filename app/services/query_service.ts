// @ts-nocheck

import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import { withCache } from '../decorators/withCache.js'
import withCost from '../decorators/withCost.js'
import {
  MESSAGE_QUERY_NO_PREFIX_AND_TRANSLATION,
  MESSAGE_QUERY_STRUCTURE,
  MESSAGE_QUERY_STRUCTURE_CURATION,
  MESSAGE_QUERY_STRUCTURE_CURATION_IMPLICIT_ONLY,
} from '../utils/prompts/query.js'
import AnalyzerService from './analyzer_service.js'
import VectorService from './vector_service.js'
import ModelsService from './models_service.js'
import type { SearchMode } from './search_text_service.js'

export default class QueryService {
  public modelsService: ModelsService = null
  public vectorService: VectorService = null
  public analyzerService: AnalyzerService = null

  constructor() {
    this.modelsService = new ModelsService()
    this.vectorService = new VectorService()
    this.analyzerService = new AnalyzerService()
  }

  public async structureQuery(query: string, searchMode: SearchMode) {
    const numberOfWords = query.split(' ').length
    if (numberOfWords > 2 || searchMode == 'curation') {
      return this.structureQueryLLM(query, searchMode)
    } else {
      return {
        structuredResult: {
          original: query,
          positive_segments: [query],
          nuances_segments: [],
          no_prefix: query,
        },
      }
    }
  }

  // withCost()
  // TODO: userid!!
  @withCache({
    provider: 'redis',
    ttl: 60 * 10,
  })
  public async structureQueryNLP(query) {
    let expansionCost = 0
    let structuredResult = await this.modelsService.getStructuredQuery(query)

    console.log(
      `[processQuery]: Result for ${query} -> ${JSON.stringify(structuredResult.positive_segments)}`
    )

    return {
      structuredResult,
      expansionCost,
    }
  }

  @MeasureExecutionTime
  public async structureQueryLLM(query, searchMode: SearchMode) {
    let expansionCost = 0

    const queryStuctureMessage =
      searchMode == 'curation'
        ? MESSAGE_QUERY_STRUCTURE_CURATION_IMPLICIT_ONLY
        : MESSAGE_QUERY_STRUCTURE

    const { result: modelOneResult, cost: modelOneCost } = await this.modelsService.getGPTResponse(
      MESSAGE_QUERY_NO_PREFIX_AND_TRANSLATION,
      JSON.stringify({ query }),
      'gpt-4o-mini'
    )

    const { result: modelResult, cost: modelTwoCost } = await this.modelsService.getGPTResponse(
      queryStuctureMessage,
      JSON.stringify({ query: modelOneResult.no_prefix }),
      searchMode == 'curation' ? 'gpt-5-chat-latest' : 'gpt-4o-mini'
    )

    modelResult.original = query
    modelResult.positive_segments = [...new Set([...modelResult.positive_segments])]
    modelResult.nuances_segments =
      searchMode == 'curation'
        ? [...new Set(Object.values(modelResult.nuances_segments).flat())]
        : []
    modelResult.no_prefix = modelOneResult.no_prefix

    console.log(
      `[processQuery]: Result for ${query} -> ${JSON.stringify(modelResult.positive_segments)} | ${JSON.stringify(modelResult.nuances_segments)}`
    )

    return {
      structuredResult: modelResult,
      noPrefixCost: modelOneCost,
      expansionCost: modelTwoCost,
    }
  }
}
