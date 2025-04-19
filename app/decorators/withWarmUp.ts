// @ts-nocheck

import { EndpointType } from '#services/models_service'

export default function withWarmUp(endpointType: EndpointType) {
  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args) {
      if (this.apiMode === 'REMOTE') {
        await this.ensureRunPodWarm(endpointType)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
