// @ts-nocheck

import axios from 'axios'
import ModelsService, { EndpointType } from './models_service.js'

export default class RunpodService {
  pingCooldownSeconds = 60
  static lastPingTimestamps: Record<string, number> = {}

  async ensureRunPodWarm(endpointType: EndpointType) {
    const modelsService = new ModelsService()
    const now = Date.now()
    const last = RunpodService.lastPingTimestamps[endpointType] || 0
    const secondsSinceLastPing = (now - last) / 1000

    if (secondsSinceLastPing < this.pingCooldownSeconds) {
      return
    }

    const { url, requestPayload, headers } = modelsService.buildRequestConfig(
      'ping',
      {},
      endpointType
    )

    try {
      console.log('[RunPod] Checking Endpoint Status for type ' + endpointType)
      await axios.post(url, requestPayload, { headers })
      RunpodService.lastPingTimestamps[endpointType] = Date.now()
      console.log('[RunPod] Endpoint warmed.')
    } catch (error) {
      console.warn('[RunPod] Ping failed (non-critical):', error.message)
    }
  }

  async setWorkerStatusIfNeeded(endpointId, desiredWorkersMin) {
    const url = 'https://api.runpod.io/graphql?api_key=' + process.env.RUNPOD_API_KEY
    const headers = { 'Content-Type': 'application/json' }

    const queryPayload = {
      query: `query {
            myself {
                endpoints {
                    id
                    name
                    gpuIds
                    templateId
                    workersMin
                }
            }
        }`,
    }

    try {
      const response = await axios.post(url, queryPayload, { headers })
      const endpoints = response.data.data.myself.endpoints
      const endpoint = endpoints.find((e) => e.id === endpointId)

      if (!endpoint) {
        console.warn(`[RunPod] Endpoint ${endpointId} not found.`)
        return
      }

      if (endpoint.workersMin === desiredWorkersMin) {
        console.log(
          `[RunPod] workersMin for ${endpoint.name} already at ${desiredWorkersMin}, no action needed.`
        )
        return
      }

      const mutationPayload = {
        query: `mutation {
                saveEndpoint(input: {
                    id: "${endpoint.id}",
                    gpuIds: "${endpoint.gpuIds}",
                    name: "${endpoint.name}",
                    templateId: "${endpoint.templateId}",
                    workersMin: ${desiredWorkersMin}
                }) {
                    id
                    workersMin
                }
            }`,
      }

      await axios.post(url, mutationPayload, { headers })
      console.log(`[RunPod] workersMin for ${endpoint.name} updated to ${desiredWorkersMin}.`)
    } catch (error) {
      console.error('[RunPod] Failed to set workersMin:', error.message)
    }
  }
}
