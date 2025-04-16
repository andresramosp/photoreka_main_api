import { Env } from '@adonisjs/core/env'

const isProduction = process.env.NODE_ENV === 'production'

const schema = {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
  REDIS_HOST: Env.schema.string({ format: 'host' }),
  REDIS_PORT: Env.schema.number(),
  REDIS_PASSWORD: Env.schema.string.optional(),
  APP_NAME: Env.schema.string(),
  REDIS_URL: Env.schema.string(),
}

// Fallback env.get() compatible wrapper
const envProxy = {
  get(key: keyof typeof schema) {
    const val = process.env[key]
    if (val === undefined) {
      throw new Error(`Missing env variable: ${key}`)
    }
    return val
  },
}

const env = isProduction ? envProxy : await Env.create(new URL('../', import.meta.url), schema)

export default env
