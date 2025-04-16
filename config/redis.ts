import { defineConfig } from '@adonisjs/redis'
import { InferConnections } from '@adonisjs/redis/types'
import { URL } from 'url'
import env from '#start/env'

const redisUrl = new URL(env.get('REDIS_URL'))
console.log('[REDIS]: ' + redisUrl)
console.log('[REDIS host]: ' + redisUrl.hostname)
console.log('[REDIS port]: ' + redisUrl.port)
console.log('[REDIS password]: ' + redisUrl.password)

const redisConfig = defineConfig({
  connection: 'main',

  connections: {
    main: {
      host: redisUrl.hostname,
      port: Number(redisUrl.port),
      password: redisUrl.password,
      db: 0,
      keyPrefix: '',
      tls: {},
      retryStrategy(times) {
        return times > 10 ? null : times * 50
      },
    },
  },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
  export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
