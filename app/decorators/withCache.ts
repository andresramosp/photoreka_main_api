import NodeCache from 'node-cache'
import redis from '@adonisjs/redis/services/main'

const nodeCache = new NodeCache()

interface CacheOptions {
  key?: ((...args: any[]) => string) | string
  provider?: 'nodecache' | 'redis'
  ttl?: number // en segundos
}

export function withCache(options: CacheOptions = {}) {
  const provider = options.provider || 'nodecache'
  const ttl = options.ttl || 60

  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: any[]) {
      let cacheKey: string

      if (options.key) {
        cacheKey = typeof options.key === 'function' ? options.key(...args) : options.key
      } else {
        const serializedArgs = JSON.stringify(args)
        // const ctx = HttpContext.get()
        // const userId = ctx?.auth?.user?.id
        cacheKey = `${propertyKey}_${serializedArgs}`
      }

      if (provider === 'nodecache') {
        const cached = nodeCache.get(cacheKey)
        if (cached !== undefined) return cached
      } else {
        const cached = await redis.get(cacheKey)
        if (cached) return JSON.parse(cached)
      }

      const result = await originalMethod.apply(this, args)

      if (provider === 'nodecache') {
        nodeCache.set(cacheKey, result, ttl)
      } else {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', ttl)
      }
      return result
    }
  }
}

export async function invalidateCache(key: string, provider: 'nodecache' | 'redis' = 'redis') {
  if (provider === 'nodecache') {
    nodeCache.del(key)
  } else {
    await redis.del(key)
  }
}
