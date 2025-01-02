import env from '#start/env'
import axios from 'axios'

const PRICES = {
  'gpt-4o': {
    input: 2.5 / 1_000_000, // USD per input token
    output: 10.0 / 1_000_000, // USD per output token
  },
  'gpt-4o-mini': {
    input: 0.15 / 1_000_000, // USD per input token
    output: 0.6 / 1_000_000, // USD per output token
  },
}

const USD_TO_EUR = 0.92

export default class ModelsService {
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

  public async bulkSemanticProximity(tags1: any, tags2: any): Promise<any> {
    try {
      const { data } = await axios.post(
        'http://127.0.0.1:5000/semantic_proximity_bulk',
        { tags1, tags2 },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      )

      return data.similarities || {}
    } catch (error) {
      console.error('Error fetching semantic proximity:', error)
      return {}
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

  public async getGPTResponse(
    systemContent: string,
    userContent: any,
    model: 'gpt-4o' | 'gpt-4o-mini' = 'gpt-4o-mini'
  ) {
    try {
      const payload = {
        model,
        temperature: 0.1,
        // top_n: 0.9,
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

      console.log(JSON.stringify(payload).length)

      const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
        headers: {
          'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
          'Content-Type': 'application/json',
        },
      })

      const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = data.usage
      const totalTokens = promptTokens + completionTokens

      const inputCost = promptTokens * PRICES[model].input * USD_TO_EUR
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

      return {
        result: parsedResult,
        cost: {
          totalCostInEur,
          inputCost,
          outputCost,
          totalTokens,
          promptTokens,
          completionTokens,
        },
      }
    } catch (error) {
      console.error('Error fetching GPT response:', error)
      return {}
    }
  }
}
