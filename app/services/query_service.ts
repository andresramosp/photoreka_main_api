// @ts-nocheck

import { withCache } from '../decorators/withCache.js'
import withCost from '../decorators/withCost.js'
import { SYSTEM_MESSAGE_QUERY_STRUCTURE } from '../utils/ModelsMessages.js'
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

    console.log(
      `[processQuery]: Result for ${query.description} -> ${JSON.stringify(structuredResult.positive_segments)}`
    )

    return {
      sourceResult,
      structuredResult,
      expansionCost,
    }
  }

  withCost()
  public async structureQueryLLM(searchType: 'logical' | 'semantic' | 'creative', query) {
    let expansionCost = 0
    let sourceResult = { requireSource: 'description' }

    const noPrefixResult = await this.modelsService.getNoPrefixQuery(query.description)

    const { result: modelResult, cost: modelCost } = await this.modelsService.getGPTResponse(
      SYSTEM_MESSAGE_QUERY_STRUCTURE,
      JSON.stringify({ query: noPrefixResult }),
      'gpt-4o-mini'
    )

    modelResult.original = query.description
    modelResult.positive_segments = [
      ...new Set([...modelResult.positive_segments, ...modelResult.named_entities]),
    ]
    modelResult.nuances_segments = [
      ...new Set(Object.values(modelResult.expanded_named_entities).flat()),
    ]
    modelResult.no_prefix = noPrefixResult

    console.log(
      `[processQuery]: Result for ${query.description} -> ${JSON.stringify(modelResult.positive_segments)} | ${JSON.stringify(modelResult.nuances_segments)}`
    )

    return {
      sourceResult,
      structuredResult: modelResult,
      expansionCost: modelCost,
    }
  }
}
