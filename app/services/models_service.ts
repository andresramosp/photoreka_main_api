// @ts-nocheck

import env from '#start/env'
import axios from 'axios'
import NodeCache from 'node-cache'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'

const cache = new NodeCache() // Simple in-memory cache

const PRICES = {
  'gpt-4o': {
    input_cache_miss: 2.5 / 1_000_000, // USD per input token
    input_cache_hit: 1.25 / 1_000_000,
    output: 10.0 / 1_000_000, // USD per output token
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

const USD_TO_EUR = 0.92

export default class ModelsService {
  @MeasureExecutionTime
  public async semanticProximity(
    text: string,
    texts: any,
    threshold: number = 0
  ): Promise<{ [key: string]: number }> {
    try {
      const isStringArray = Array.isArray(texts) && texts.every((item) => typeof item === 'string')
      const endpoint = isStringArray
        ? 'http://127.0.0.1:5000/semantic_proximity'
        : 'http://127.0.0.1:5000/semantic_proximity_obj'

      const payload = isStringArray
        ? {
            tag: text,
            tag_list: texts,
            threshold,
          }
        : {
            tag: text,
            tag_list: texts.map((item: any) => ({ id: item.id, text: item.text })),
          }

      const { data } = await axios.post(endpoint, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data.similarities || {}
    } catch (error) {
      console.error('Error fetching semantic proximity:', error)
      return {}
    }
  }

  @MeasureExecutionTime
  public async semanticProximitChunks(
    text1: string,
    text2: any,
    chunkSize: number = 50
  ): Promise<any[]> {
    try {
      const payload = {
        text1,
        text2,
        chunk_size: chunkSize,
      }

      const { data } = await axios.post(
        'http://127.0.0.1:5000/semantic_proximity_chunks',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )

      return data || []
    } catch (error) {
      console.error('Error fetching semantic proximity:', error)
      return {}
    }
  }

  public async getEmbeddings(tags: string[]): Promise<{ embeddings: number[][] }> {
    try {
      const payload = {
        tags,
      }

      const { data } = await axios.post('http://127.0.0.1:5000/get_embeddings', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data || {}
    } catch (error) {
      console.error('Error fetching semantic proximity:', error)
      return { embeddings: [] }
    }
  }

  public async textToTags(text: string): Promise<string[]> {
    try {
      const payload = { description: text }
      const { data } = await axios.post('http://127.0.0.1:5000/generate_tags', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data.generated_tags || []
    } catch (error) {
      console.error('Error fetching tags by description:', error)
      return []
    }
  }

  public async getSynonymTags(tag: string, tagList: string[]): Promise<string[]> {
    try {
      const payload = {
        tag,
        tag_list: tagList,
        proximity_threshold: 0.7,
        apply_semantic_proximity: false,
      }
      const { data } = await axios.post('http://127.0.0.1:5000/get_synonym_tags', payload, {
        headers: {
          'Content-Type': 'application/json',
        },
      })

      return data.matches || []
    } catch (error) {
      console.error('Error fetching tags by description:', error)
      return []
    }
  }

  public async getSemanticSynonymTags(tag: string, tagList: string[]): Promise<{ matches: any[] }> {
    try {
      const payload = {
        tag,
        tag_list: tagList,
        proximity_threshold: 0.9,
      }
      const { data } = await axios.post(
        'http://127.0.0.1:5000/get_advanced_synonym_tags',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )

      return data.matches || []
    } catch (error) {
      // console.error('Error fetching tags:', error)
      return []
    }
  }

  @MeasureExecutionTime
  public async getGPTResponse(
    systemContent: string | null,
    userContent: any,
    model:
      | 'gpt-4o'
      | 'gpt-4o-mini'
      | 'ft:gpt-4o-mini-2024-07-18:personal:refine:AlpaXAxW' = 'gpt-4o-mini',
    responseFormat: any = { type: 'json_object' },
    temperature: number = 0.1,
    useCache: boolean = true
  ): Promise<any> {
    let cacheDuration = 60 * 5
    try {
      let payload: any = {
        model,
        temperature,
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
          // inputCost,
          // outputCost,
          totalTokens,
          // promptTokens,
          promptCacheMissTokens: promptTokens - promptTokensDetails.cached_tokens,
          promptCacheHitTokens: promptTokensDetails.cached_tokens,
          completionTokens,
        },
      }

      // Cache the result
      if (useCache) cache.set(cacheKey, result, cacheDuration)

      return result
    } catch (error) {
      console.error('Error fetching GPT response:', error)
      return {}
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
