import PhotosService from '#services/photos_service'
import NodeCache from 'node-cache'

const cache = new NodeCache()

interface CacheOptions {
  key?: (...args: any[]) => string // Función para generar la llave a partir de los argumentos
  ttl?: number // Tiempo de vida (en segundos)
}

export function withCache(options: CacheOptions = {}) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    descriptor.value = async function (...args: any[]) {
      // Genera la llave: si se provee una función, la usamos, sino, JSON.stringify de los args
      const cacheKey = options.key ? options.key(...args) : `${propertyKey}_${JSON.stringify(args)}`
      const cachedResult = cache.get(cacheKey)
      if (cachedResult !== undefined) {
        return cachedResult
      }
      const result = await originalMethod.apply(this, args)
      cache.set(cacheKey, result, options.ttl)
      return result
    }
  }
}
