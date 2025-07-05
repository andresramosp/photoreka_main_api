// @ts-nocheck

import env from '#start/env'
import axios from 'axios'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import withWarmUp from '../decorators/withWarmUp.js'
import { withCache } from '../decorators/withCache.js'

const cache = new NodeCache() // Simple in-memory cache

const PRICES = {
  'gpt-4o': {
    input_cache_miss: 2.5 / 1_000_000, // USD per input token
    input_cache_hit: 1.25 / 1_000_000,
    output: 10.0 / 1_000_000, // USD per output token
  },
  'gpt-4.1': {
    input_cache_miss: 2 / 1_000_000, // USD per input token
    input_cache_hit: 0.5 / 1_000_000,
    output: 8 / 1_000_000, // USD per output token
  },
  'gpt-4o-mini': {
    input_cache_miss: 0.15 / 1_000_000, // USD per input token
    input_cache_hit: 0.075 / 1_000_000,
    output: 0.6 / 1_000_000, // USD per output token
  },
  'ft:gpt-4o-mini-2024-07-18:personal:refine:AlpaXAxW': {
    input: 0.3 / 1_000_000, // USD per input token
    output: 1.2 / 1_000_000, // USD per output token
  },
  'ft:gpt-4o-mini-2024-07-18:personal:curatorlab-term-expansor-v3-lr:AldGdmpv': {
    input: 0.3 / 1_000_000, // USD per input token
    output: 1.2 / 1_000_000, // USD per output token
  },
  'deepseek-chat': {
    input_cache_miss: 0.27 / 1_000_000, // USD per input token
    input_cache_hit: 0.07 / 1_000_000, // USD per input token
    output: 1.1 / 1_000_000, // USD per output token
  },
}

export type EndpointType = 'embeddings_gpu' | 'embeddings_cpu' | 'logic_cpu' | 'logic_gpu' | 'image'

const USD_TO_EUR = 0.92

export default class ModelsService {
  constructor() {
    this.apiMode = process.env.API_MODELS
    this.remoteBaseUrlLogicGPU = process.env.REMOTE_API_BASE_URL_LOGIC_GPU
    this.remoteBaseUrlLogicCPU = process.env.REMOTE_API_BASE_URL_LOGIC_CPU
    this.remoteBaseUrlImage = process.env.REMOTE_API_BASE_URL_IMAGE
    this.remoteBaseUrlEmbeddingsGPU = process.env.REMOTE_API_BASE_URL_EMBEDDINGS_GPU
    this.remoteBaseUrlEmbeddingsCPU = process.env.REMOTE_API_BASE_URL_EMBEDDINGS_CPU
    this.localBaseUrl = process.env.LOCAL_API_BASE_URL
    this.runpodApiKey = process.env.RUNPOD_API_KEY
    this.pingCooldownSeconds = 300
  }

  static lastPingTimestamps: Record<string, number> = {}

  public async ensureRunPodWarm(endpointType: EndpointType) {
    const now = Date.now()
    const last = ModelsService.lastPingTimestamps[endpointType] || 0
    const secondsSinceLastPing = (now - last) / 1000

    if (secondsSinceLastPing < this.pingCooldownSeconds) {
      return
    }

    const { url, requestPayload, headers } = this.buildRequestConfig('ping', {}, endpointType)

    try {
      console.log('[RunPod] Checking Endpoint Status for type ' + endpointType)
      await axios.post(url, requestPayload, { headers })
      ModelsService.lastPingTimestamps[endpointType] = Date.now()
      console.log('[RunPod] Endpoint warmed.')
    } catch (error) {
      console.warn('[RunPod] Ping failed (non-critical):', error.message)
    }
  }

  buildRequestConfig(operation, payload, endpointType: EndpointType) {
    let url = ''
    let requestPayload = payload
    const headers = { 'Content-Type': 'application/json' }

    if (this.apiMode === 'REMOTE') {
      if (endpointType == 'embeddings_gpu') {
        url = this.remoteBaseUrlEmbeddingsGPU
      }
      if (endpointType == 'embeddings_cpu') {
        url = this.remoteBaseUrlEmbeddingsCPU
      }
      if (endpointType == 'logic_gpu') {
        url = this.remoteBaseUrlLogicGPU
      }
      if (endpointType == 'logic_cpu') {
        url = this.remoteBaseUrlLogicCPU
      }
      if (endpointType == 'image') {
        url = this.remoteBaseUrlImage
      }
      requestPayload =
        endpointType == 'embeddings_gpu'
          ? { input: { input: payload } }
          : {
              input: {
                operation,
                data: payload,
              },
            }
      if (this.runpodApiKey) {
        headers['Authorization'] = `Bearer ${this.runpodApiKey}`
      }
    } else {
      url = `${this.localBaseUrl}/${operation}`
    }

    return { url, requestPayload, headers }
  }

  @MeasureExecutionTime
  async adjustProximitiesByContextInference(
    term,
    texts,
    termsType = 'tag',
    forceCPU: boolean = false
  ) {
    const isGPU = !forceCPU
    try {
      // Filtrado único por name + group
      const uniqueTexts = Object.values(
        texts.reduce((acc, item) => {
          const key = `${item.name}::${item.group}`
          if (!acc[key]) acc[key] = item
          return acc
        }, {})
      )

      let payload = {
        term,
        tag_list: uniqueTexts.map((tag) => ({ name: tag.name, group: tag.group })), //.slice(0, 5),
        premise_wrapper: 'the photo has the following fragment in its description: {term}',
        hypothesis_wrapper: 'the photo features {term}',
      }

      const operation =
        termsType === 'tag'
          ? 'adjust_tags_proximities_by_context_inference'
          : 'adjust_descs_proximities_by_context_inference'

      const { url, requestPayload, headers } = this.buildRequestConfig(
        operation,
        payload,
        isGPU ? 'logic_gpu' : 'logic_cpu'
      )

      let { data } = await axios.post(url, requestPayload, { headers })

      data = data.output ? data.output : data

      return texts.map((text) => ({
        ...text,
        embeddingsProximity: text.proximity,
        logicProximity: data[text.name]?.adjusted_proximity,
      }))
    } catch (error) {
      console.error('Error en adjustProximitiesByContextInference:', error.message)
      return []
    }
  }

  // async getEmbeddingsGPU(tags) {
  //   const isRemoteGPU = this.apiMode === 'REMOTE'

  //   if (this.apiMode === 'REMOTE') await this.ensureRunPodWarm('embeddings_gpu')

  //   try {
  //     const { url, requestPayload, headers } = this.buildRequestConfig(
  //       'get_embeddings',
  //       isRemoteGPU
  //         ? tags
  //         : {
  //             tags,
  //           },
  //       'embeddings_gpu'
  //     )

  //     const { data } = await axios.post(url, requestPayload, { headers })

  //     if (this.apiMode === 'LOCAL') {
  //       return data
  //     } else {
  //       return data.output
  //         ? {
  //             embeddings: isRemoteGPU
  //               ? data.output.data.map((d) => d.embedding)
  //               : data.output.embeddings,
  //           }
  //         : { embeddings: [] }
  //     }
  //   } catch (error) {
  //     console.error('Error en getEmbeddings:', error.message, JSON.stringify(tags))
  //     return { embeddings: [] }
  //   }
  // }

  // @withWarmUp('image')
  async getEmbeddingsImages(images: { id: number; base64: string }[]) {
    const maxRetries = 3
    const baseDelay = 1000 // ms

    const payload = { images }
    const { url, requestPayload, headers } = this.buildRequestConfig(
      'get_embeddings_image',
      payload,
      'image'
    )

    let attempt = 0
    while (attempt < maxRetries) {
      try {
        const { data } = await axios.post(url, requestPayload, { headers })
        return { embeddings: data.output ? data.output : data || [] }
      } catch (error) {
        attempt++
        const isLast = attempt === maxRetries
        console.error(`Error en getEmbeddingsImages (intento ${attempt}):`, error.message)
        if (isLast) break
        // Backoff exponencial simple
        await new Promise((res) => setTimeout(res, baseDelay * Math.pow(2, attempt)))
      }
    }
    return { embeddings: [] }
  }

  async getEmbeddingsCPU(tags) {
    try {
      const { data } = await axios.post(process.env.PYTHON_API_CPU + '/embeddings', { tags })

      return data
    } catch (error) {
      console.error('Error en getEmbeddings:', error.message, JSON.stringify(tags))
      return { embeddings: [] }
    }
  }

  async getHistogramColor(images) {
    try {
      const { data } = await axios.post(process.env.PYTHON_API_CPU + '/color-histograms', {
        images,
      })

      return data
    } catch (error) {
      console.error('Error en getEmbeddings:', error.message, JSON.stringify(images))
      return { embeddings: [] }
    }
  }
  @withWarmUp('image')
  async getPresenceMaps(images: { id: string; base64: string }) {
    try {
      const payload = { images }
      const { url, requestPayload, headers } = this.buildRequestConfig(
        'generate_presence_maps',
        payload,
        'image'
      )

      const { data } = await axios.post(url, requestPayload, { headers })

      return { maps: data }
    } catch (error) {
      console.error('Error en getPresenceMaps:', error.message)
      return { maps: [] }
    }
  }

  @withWarmUp('image')
  async getObjectsDetections(images: { id: number; base64: string }[], categories: any[]) {
    try {
      const payload = { images, categories }
      const { url, requestPayload, headers } = this.buildRequestConfig(
        'detect_objects_base64',
        payload,
        'image'
      )

      const { data } = await axios.post(url, requestPayload, { headers })

      return { detections: data.output ? data.output : data || [] }
    } catch (error) {
      console.error('Error en getObjectsDetections:', error.message)
      return { detections: [] }
    }
  }

  async findSimilarPresenceMaps(image: { id: string }) {
    try {
      const payload = image
      const { url, requestPayload, headers } = this.buildRequestConfig(
        'find_similar_presence_maps',
        payload,
        'image'
      )

      const { data } = await axios.post(url, requestPayload, { headers })

      if (!data.results) {
        console.log()
      }
      return data.results
    } catch (error) {
      console.error('Error en findSimilarPresenceMaps:', error.message)
      return { photos: [] }
    }
  }

  // @withWarmUp('logic_gpu')
  // @MeasureExecutionTime
  // async generateGroupsForTags(tags) {
  //   try {
  //     const payload = { tags }
  //     const { url, requestPayload, headers } = this.buildRequestConfig(
  //       'generate_groups_for_tags',
  //       payload,
  //       'logic_gpu'
  //     )

  //     const { data } = await axios.post(url, requestPayload, { headers })

  //     return data.output ? data.output : data || []
  //   } catch (error) {
  //     console.error('Error en generateGroupsForTags:', error.message)
  //     return []
  //   }
  // }

  // @MeasureExecutionTime
  @withWarmUp((texts, extract_ratio, forceCPU) => (forceCPU ? 'logic_cpu' : 'logic_gpu'))
  async cleanDescriptions(texts, extract_ratio = 0.9, forceCPU: boolean = false) {
    try {
      const payload = {
        texts,
        extract_ratio,
        purge_list: [],
      }
      const { url, requestPayload, headers } = this.buildRequestConfig(
        'clean_texts',
        payload,
        forceCPU ? 'logic_cpu' : 'logic_gpu'
      )

      const { data } = await axios.post(url, requestPayload, { headers })

      return data.output ? data.output : data || []
    } catch (error) {
      console.error('Error en cleanDescriptions:', error.message)
      return []
    }
  }

  // @withWarmUp('logic_gpu')
  // @MeasureExecutionTime
  // async getStructuredQuery(query) {
  //   try {
  //     const payload = { query }
  //     const { url, requestPayload, headers } = this.buildRequestConfig(
  //       'query_segment',
  //       payload,
  //       'logic_gpu'
  //     )

  //     const { data } = await axios.post(url, requestPayload, { headers })

  //     return data.output ? data.output : data || {}
  //   } catch (error) {
  //     console.error('Error en getStructuredQuery:', error.message)
  //     return {}
  //   }
  // }

  // @withWarmUp('logic_gpu')
  // @MeasureExecutionTime
  // async getNoPrefixQuery(query) {
  //   try {
  //     const payload = { query }
  //     const { url, requestPayload, headers } = this.buildRequestConfig(
  //       'query_no_prefix',
  //       payload,
  //       'logic_gpu'
  //     )

  //     const { data } = await axios.post(url, requestPayload, { headers })

  //     return data.output ? data.output : data || {}
  //   } catch (error) {
  //     console.error('Error en getStructuredQuery:', error.message)
  //     return {}
  //   }
  // }

  @MeasureExecutionTime
  public async getMolmoResponse(imagesItems, prompts, promptsPerImage): Promise<any> {
    try {
      // Se asume que imagesItems es un array de objetos { id, base64 }
      const imagesArray = imagesItems.map((item) => ({
        id: item.id,
        base64: item.base64.startsWith('data:image')
          ? item.base64
          : `data:image/jpeg;base64,${item.base64}`,
      }))

      const response = await fetch(`${env.get('HF_MOLMO_ENDPOINT')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.get('HF_KEY')}`,
        },
        body: JSON.stringify({
          inputs: {
            images: imagesArray,
            prompts,
            prompts_per_image: promptsPerImage,
            batch_size: 4,
            generation_config: {
              temperature: 0.1,
              max_new_tokens: 200,
              max_crops: 9,
              overlap_margins: [4, 4],
              float16: true,
            },
            config: { top_p: 1 },
          },
        }),
      })

      if (!response.ok) {
        throw new Error(`Error en la API de HF: ${response.statusText}`)
      }

      // Se espera que la respuesta sea un array de objetos con los resultados y los ids asociados
      let parsedResult = await response.json()

      return { result: parsedResult }
    } catch (error) {
      console.error('Error al obtener respuesta del endpoint de HF:', error)
      throw error // re-lanza la excepción para que se active la lógica de reintentos
    }
  }

  // @MeasureExecutionTime
  public async getGPTResponse(
    systemContent: string | null,
    userContent: any,
    model:
      | 'gpt-4o'
      | 'gpt-4.1'
      | 'gpt-4o-mini'
      | 'ft:gpt-4o-mini-2024-07-18:personal:refine:AlpaXAxW' = 'gpt-4o-mini',
    responseFormat: any = { type: 'json_object' },
    temperature: number = 0.1,
    useCache: boolean = true
  ): Promise<any> {
    let cacheDuration = 60 * 5
    try {
      const simulateErrorRate: number = 0

      // Simular fallo aleatorio si está activado
      if (simulateErrorRate > 0 && Math.random() < simulateErrorRate) {
        console.warn('Simulando error artificial en getGPTResponse()')
        throw new Error('Simulated GPT request failure')
      }

      let payload: any = {
        model,
        temperature,
        frequency_penalty: 0,
        top_p: 1,
        messages: systemContent
          ? [
              {
                role: 'system',
                content: systemContent,
              },
              {
                role: 'user',
                content: userContent,
              },
            ]
          : [
              {
                role: 'user',
                content: userContent,
              },
            ],
        max_tokens: 15000,
      }

      if (responseFormat) {
        payload.response_format = responseFormat
      }

      const cacheKey = JSON.stringify({ systemContent, userContent, model })

      // Check cache
      const cachedResponse = cache.get(cacheKey)
      if (useCache && cachedResponse) {
        console.log('Cache hit for getGPTResponse')
        return cachedResponse
      }

      const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
        headers: {
          'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
          'Content-Type': 'application/json',
        },
      })

      const {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_tokens_details: promptTokensDetails,
      } = data.usage

      const totalTokens = promptTokens + completionTokens

      const inputCostCacheMiss =
        (promptTokens - promptTokensDetails.cached_tokens) *
        PRICES[model].input_cache_miss *
        USD_TO_EUR
      const inputCostCacheHit =
        promptTokensDetails.cached_tokens * PRICES[model].input_cache_hit * USD_TO_EUR
      const inputCost = inputCostCacheMiss + inputCostCacheHit

      const outputCost = completionTokens * PRICES[model].output * USD_TO_EUR
      const totalCostInEur = inputCost + outputCost

      const rawResult = data.choices[0].message.content
      let parsedResult

      try {
        parsedResult = JSON.parse(rawResult.replace(/```(?:json)?\s*/g, '').trim())
      } catch {
        const jsonArrayMatch = rawResult.match(/\[.*?\]/s)
        const jsonObjectMatch = rawResult.match(/\{.*?\}/s)
        if (jsonArrayMatch) {
          parsedResult = JSON.parse(jsonArrayMatch[0])
        } else if (jsonObjectMatch) {
          parsedResult = JSON.parse(jsonObjectMatch[0])
        } else {
          parsedResult = {}
        }
      }

      const result = {
        result: parsedResult.result
          ? parsedResult.result
          : parsedResult.results
            ? parsedResult.results
            : parsedResult,
        cost: {
          totalCostInEur,
          totalTokens,
          promptCacheMissTokens: promptTokens - promptTokensDetails.cached_tokens,
          promptCacheHitTokens: promptTokensDetails.cached_tokens,
          completionTokens,
        },
      }

      // Cache the result
      if (useCache) cache.set(cacheKey, { ...result, cost: '0 [cached]' }, cacheDuration)

      return result
    } catch (error) {
      console.error('Error fetching GPT response:', error)
      throw error
    }
  }

  @MeasureExecutionTime
  public async getDSResponse(
    systemContent: string | null,
    userContent: any,
    model: 'deepseek-chat' = 'deepseek-chat',
    responseFormat: any = { type: 'json_object' },
    temperature: number = 0.1,
    useCache: boolean = true
  ): Promise<any> {
    let cacheDuration = 60 * 30
    try {
      let payload: any = {
        model,
        temperature,
        stream: false,
        messages: systemContent
          ? [
              {
                role: 'system',
                content: systemContent,
              },
              {
                role: 'user',
                content: userContent,
              },
            ]
          : [
              {
                role: 'user',
                content: userContent,
              },
            ],
      }

      const cacheKey = JSON.stringify({ systemContent, userContent, model })

      if (responseFormat) {
        payload.response_format = responseFormat
      }

      // Check cache
      const cachedResponse = cache.get(cacheKey)
      if (useCache && cachedResponse) {
        console.log('Cache hit for getGPTResponse')
        return cachedResponse
      }

      const { data } = await axios.post(
        `${env.get('DEEPSEEK_BASEURL')}/chat/completions`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${env.get('DEEPSEEK_KEY')}`,
            'Content-Type': 'application/json',
          },
        }
      )

      const {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_cache_miss_tokens: promptCacheMissTokens,
        prompt_cache_hit_tokens: promptCacheHitTokens,
      } = data.usage

      const totalTokens = promptTokens + completionTokens

      const inputCostCacheMiss = promptCacheMissTokens * PRICES[model].input_cache_miss * USD_TO_EUR
      const inputCostCacheHit = promptCacheHitTokens * PRICES[model].input_cache_hit * USD_TO_EUR
      const inputCost = inputCostCacheMiss + inputCostCacheHit

      const outputCost = completionTokens * PRICES[model].output * USD_TO_EUR
      const totalCostInEur = inputCost + outputCost

      const rawResult = data.choices[0].message.content
      let parsedResult

      try {
        parsedResult = JSON.parse(rawResult.replace(/```(?:json)?\s*/g, '').trim())
      } catch {
        const jsonArrayMatch = rawResult.match(/\[.*?\]/s)
        const jsonObjectMatch = rawResult.match(/\{.*?\}/s)
        if (jsonArrayMatch) {
          parsedResult = JSON.parse(jsonArrayMatch[0])
        } else if (jsonObjectMatch) {
          parsedResult = JSON.parse(jsonObjectMatch[0])
        } else {
          parsedResult = {}
        }
      }

      const result = {
        result: parsedResult.result
          ? parsedResult.result
          : parsedResult.results
            ? parsedResult.results
            : parsedResult,
        cost: {
          totalCostInEur,
          // inputCost,
          // outputCost,
          totalTokens,
          // promptTokens,
          promptCacheMissTokens,
          promptCacheHitTokens,
          completionTokens,
        },
      }

      // Cache the result
      if (useCache) cache.set(cacheKey, { ...result, cost: '0 [cached]' }, cacheDuration)

      return result
    } catch (error) {
      console.error('Error fetching DS response:', error)
      return {}
    }
  }
}
