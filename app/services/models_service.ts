import env from '#start/env'
import axios from 'axios'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

export default class ModelsService {
  public async semanticProximity(text: string, texts: any): Promise<{ [key: string]: number }> {
    try {
      const isStringArray = Array.isArray(texts) && texts.every((item) => typeof item === 'string')
      const endpoint = isStringArray
        ? 'http://127.0.0.1:5000/semantic_proximity'
        : 'http://127.0.0.1:5000/semantic_proximity_obj'

      const payload = isStringArray
        ? {
            tag: text,
            tag_list: texts,
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

  public async getGPTResponse(systemContent: string, userContent: any) {
    const payload = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: systemContent,
        },
        {
          role: 'user',
          content: JSON.stringify(userContent),
        },
      ],
      max_tokens: 10000,
    }

    const { data } = await axios.post(`${env.get('OPENAI_BASEURL')}/chat/completions`, payload, {
      headers: {
        'Authorization': `Bearer ${env.get('OPENAI_KEY')}`,
        'Content-Type': 'application/json',
      },
    })

    const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = data.usage
    const totalTokens = promptTokens + completionTokens
    const costInEur = totalTokens * COST_PER_TOKEN_EUR

    const rawResult = data.choices[0].message.content
    const jsonMatch = rawResult.match(/\{.*?\}/s)
    return jsonMatch ? { ...JSON.parse(jsonMatch[0]), costInEur, totalTokens } : {}
  }
}
