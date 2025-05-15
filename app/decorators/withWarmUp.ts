// @ts-nocheck

import { EndpointType } from '#services/models_service'

export default function withWarmUp(
  endpointTypeOrFn: EndpointType | ((...args: any[]) => EndpointType)
) {
  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args) {
      const endpointType =
        typeof endpointTypeOrFn === 'function' ? endpointTypeOrFn(...args) : endpointTypeOrFn

      if (this.apiMode === 'REMOTE') {
        await this.ensureRunPodWarm(endpointType)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
