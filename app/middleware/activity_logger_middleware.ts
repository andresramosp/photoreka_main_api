import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

import type { ActivityType } from '#models/user_activity'
import LoggerManager from '../managers/logger_manager.js'

export default class ActivityLoggerMiddleware {
  private loggerManager: LoggerManager

  constructor() {
    this.loggerManager = new LoggerManager()
  }

  async handle(ctx: HttpContext, next: NextFn) {
    const { request, response, auth } = ctx
    const startTime = Date.now()

    try {
      // Ejecutar el siguiente middleware/controller
      await next()

      // Intentar obtener el usuario para logging
      const responseTime = Date.now() - startTime
      const statusCode = response.getStatus()
      let userId: number | null = null

      // Intenta obtener el usuario de diferentes maneras
      try {
        // Verificar primero si hay un usuario autenticado usando el patrón correcto
        await auth.use('api').check()
        const user = auth.use('api').user!
        userId = user.id
      } catch (authError) {
        // Para endpoints como login/register, podemos extraer el userId de la response
        if (statusCode >= 200 && statusCode < 300) {
          const responseBody = response.getBody()
          if (responseBody && typeof responseBody === 'object') {
            // Login/Register devuelven el user en la response
            if ('user' in responseBody && responseBody.user && 'id' in responseBody.user) {
              userId = responseBody.user.id
            }
          }
        }
      }

      // Solo loggear si tenemos un userId
      if (userId) {
        const activityType = this.getActivityTypeFromEndpoint(request.url(), request.method())

        if (activityType) {
          // Extraer información del request
          const requestData = this.extractRequestData(request)

          // Log con información detallada del request (sin api_call genérico)
          await this.loggerManager.logActivity({
            userId,
            type: activityType,
            action: `${request.method()} ${request.url()}`,
            level: statusCode >= 400 ? 'error' : statusCode >= 300 ? 'warning' : 'info',
            ipAddress: request.ip(),
            userAgent: request.header('user-agent'),
            endpoint: request.url(),
            statusCode,
            responseTime,
            metadata: {
              method: request.method(),
              queryString: request.qs(),
              payload: requestData.payload,

              ...requestData.additional,
            },
          })
        }
      }
    } catch (error) {
      // Para errores, solo loggear si tenemos un usuario autenticado
      let userId: number | null = null
      try {
        await auth.use('api').check()
        const user = auth.use('api').user!
        userId = user.id
      } catch (authError) {
        // Sin usuario autenticado, no loggeamos errores (evita spam)
      }

      if (userId) {
        const responseTime = Date.now() - startTime
        const requestData = this.extractRequestData(request)

        await this.loggerManager.logError(
          userId,
          `Error in ${request.method()} ${request.url()}`,
          error as Error,
          {
            endpoint: request.url(),
            method: request.method(),
            responseTime,
            ipAddress: request.ip(),
            userAgent: request.header('user-agent'),
            queryString: request.qs(),
            payload: requestData.payload,
            contentType: request.header('content-type'),
            referer: request.header('referer'),
            ...requestData.additional,
          }
        )
      }

      throw error
    }
  } /**
   * Determina el tipo de actividad basado en el endpoint y método HTTP
   */
  private getActivityTypeFromEndpoint(url: string, method: string): ActivityType | null {
    // Mapeo de endpoints a tipos de actividad
    const endpointMap: { pattern: RegExp; type: ActivityType }[] = [
      { pattern: /\/auth\/login/, type: 'login' },
      { pattern: /\/auth\/register/, type: 'register' },
      { pattern: /\/auth\/logout/, type: 'logout' },
      { pattern: /\/auth\/profile/, type: 'update_profile' },
      { pattern: /\/auth\/change-password/, type: 'change_password' },
      { pattern: /\/search\/semantic/, type: 'search_text' },
      { pattern: /\/search\/byPhotos/, type: 'search_visual' },
      { pattern: /\/search\/tags/, type: 'search' },
      { pattern: /\/search\/topological/, type: 'search' },
      {
        pattern: /\/collections.*/,
        type:
          method === 'POST'
            ? 'create_collection'
            : method === 'DELETE'
              ? 'delete_collection'
              : 'view_catalog',
      },
      {
        pattern: /\/photos.*/,
        type:
          method === 'POST'
            ? 'upload_photo'
            : method === 'DELETE'
              ? 'delete_photo'
              : 'view_catalog',
      },
      {
        pattern: /\/tags.*/,
        type:
          method === 'POST' ? 'create_tag' : method === 'DELETE' ? 'delete_tag' : 'view_catalog',
      },
      { pattern: /\/catalog/, type: 'view_catalog' },
      { pattern: /\/usage/, type: 'view_usage' },
      { pattern: /\/analyzer/, type: 'analyze_photo' },
      { pattern: /\/warmup/, type: 'warmup_system' },
    ]

    for (const { pattern, type } of endpointMap) {
      if (pattern.test(url)) {
        return type
      }
    }

    // Si no coincide con ningún patrón específico, no loggear (devolver null)
    return null
  }

  /**
   * Extrae información segura del request para logging
   */
  private extractRequestData(request: any): { payload: any; additional: Record<string, any> } {
    let payload: any = null
    const additional: Record<string, any> = {}

    try {
      // Obtener el body del request de forma segura
      const body = request.body()

      if (body && typeof body === 'object') {
        // Filtrar campos sensibles como passwords
        payload = this.sanitizePayload(body)
      }

      // Información adicional del request
      additional.contentLength = request.header('content-length')
      additional.origin = request.header('origin')
      additional.acceptLanguage = request.header('accept-language')

      // Extraer parámetros de la URL si existen
      const params = request.params()
      if (params && Object.keys(params).length > 0) {
        additional.urlParams = params
      }
    } catch (error) {
      // Si hay error extrayendo datos, no fallar el middleware
      additional.extractionError = 'Failed to extract request data'
    }

    return { payload, additional }
  }

  /**
   * Sanitiza el payload removiendo información sensible
   */
  private sanitizePayload(payload: any): any {
    if (!payload || typeof payload !== 'object') {
      return payload
    }

    const sensitiveFields = [
      'password',
      'currentPassword',
      'newPassword',
      'token',
      'accessToken',
      'refreshToken',
      'secret',
      'key',
      'authCode',
    ]

    const sanitized = { ...payload }

    // Remover campos sensibles
    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]'
      }
    }

    // Si hay nested objects, sanitizar recursivamente
    for (const key in sanitized) {
      if (sanitized[key] && typeof sanitized[key] === 'object') {
        sanitized[key] = this.sanitizePayload(sanitized[key])
      }
    }

    return sanitized
  }
}
