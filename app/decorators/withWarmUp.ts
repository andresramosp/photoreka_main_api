// @ts-nocheck

export default function withWarmUp() {
  return function (target, propertyKey, descriptor) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args) {
      if (this.apiMode === 'REMOTE') {
        await this.ensureRunPodWarm()
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
