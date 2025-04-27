import { defineConfig } from '@adonisjs/redis'
import { InferConnections } from '@adonisjs/redis/types'
import { URL } from 'url'
import env from '#start/env'

// Validamos explícitamente
const redisUrlString = env.get('REDIS_URL')
if (!redisUrlString) {
  throw new Error('[REDIS]: REDIS_URL no está definido en el entorno')
}

const redisUrl = new URL(redisUrlString)

const redisConfig = defineConfig({
  connection: 'main',
  connections: {
    main: {
      host: redisUrl.hostname,
      port: Number(redisUrl.port),
      password: redisUrl.password || undefined,
      db: Number(redisUrl.pathname.slice(1)) || 0,
      tls: redisUrl.protocol === 'rediss:' ? {} : undefined, // Soporte TLS si la URL es rediss://
    },
  },
})

export default redisConfig

declare module '@adonisjs/redis/types' {
  export interface RedisConnections extends InferConnections<typeof redisConfig> {}
}
