import { Env } from '@adonisjs/core/env'

const isProduction = process.env.NODE_ENV === 'production'

export default isProduction
  ? {
      NODE_ENV: process.env.NODE_ENV,
      PORT: Number(process.env.PORT),
      APP_KEY: process.env.APP_KEY,
      HOST: process.env.HOST,
      LOG_LEVEL: process.env.LOG_LEVEL,

      DB_HOST: process.env.DB_HOST,
      DB_PORT: Number(process.env.DB_PORT),
      DB_USER: process.env.DB_USER,
      DB_PASSWORD: process.env.DB_PASSWORD,
      DB_DATABASE: process.env.DB_DATABASE,

      REDIS_HOST: process.env.REDIS_HOST,
      REDIS_PORT: Number(process.env.REDIS_PORT),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    }
  : await Env.create(new URL('../', import.meta.url), {
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
    })
