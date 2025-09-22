import UserActivity from '#models/user_activity'
import type { ActivityType, ActivityLevel } from '#models/user_activity'
import { DateTime } from 'luxon'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import Logger from '../utils/logger.js'

const logger = Logger.getInstance('LoggerManager')

export interface LogActivityData {
  userId: number
  type: ActivityType
  action: string
  level?: ActivityLevel
  description?: string
  metadata?: Record<string, any>
  ipAddress?: string
  userAgent?: string
  endpoint?: string
  statusCode?: number
  responseTime?: number
}

export default class LoggerManager {
  constructor() {}

  /**
   * Registra una actividad del usuario
   */
  @MeasureExecutionTime
  public async logActivity(data: LogActivityData): Promise<UserActivity> {
    try {
      const activity = await UserActivity.create({
        userId: data.userId,
        type: data.type,
        level: data.level || 'info',
        action: data.action,
        description: data.description,
        metadata: data.metadata,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent,
        endpoint: data.endpoint,
        statusCode: data.statusCode,
        responseTime: data.responseTime,
      })

      logger.info(`Activity logged for user ${data.userId}: ${data.type} - ${data.action}`)
      return activity
    } catch (error) {
      logger.error('Error logging user activity:', error)
      throw error
    }
  }

  /**
   * Obtiene las actividades de un usuario con paginación
   */
  @MeasureExecutionTime
  public async getUserActivities(
    userId: number,
    page: number = 1,
    limit: number = 50,
    type?: ActivityType,
    level?: ActivityLevel
  ): Promise<{
    data: UserActivity[]
    meta: {
      total: number
      perPage: number
      currentPage: number
      lastPage: number
    }
  }> {
    try {
      const query = UserActivity.query().where('user_id', userId).orderBy('created_at', 'desc')

      if (type) {
        query.where('type', type)
      }

      if (level) {
        query.where('level', level)
      }

      const result = await query.paginate(page, limit)

      return {
        data: result.all(),
        meta: result.getMeta(),
      }
    } catch (error) {
      logger.error(`Error getting activities for user ${userId}:`, error)
      throw error
    }
  }

  /**
   * Obtiene las actividades por tipo en un rango de fechas
   */
  @MeasureExecutionTime
  public async getActivitiesByType(
    type: ActivityType,
    startDate?: DateTime,
    endDate?: DateTime,
    limit: number = 100
  ): Promise<UserActivity[]> {
    try {
      const query = UserActivity.query()
        .where('type', type)
        .orderBy('created_at', 'desc')
        .limit(limit)

      if (startDate) {
        query.where('created_at', '>=', startDate.toSQL()!)
      }

      if (endDate) {
        query.where('created_at', '<=', endDate.toSQL()!)
      }

      return await query.exec()
    } catch (error) {
      logger.error(`Error getting activities by type ${type}:`, error)
      throw error
    }
  }

  /**
   * Obtiene estadísticas de actividad para un usuario
   */
  @MeasureExecutionTime
  public async getUserActivityStats(
    userId: number,
    days: number = 30
  ): Promise<{
    totalActivities: number
    activitiesByType: Record<ActivityType, number>
    activitiesByLevel: Record<ActivityLevel, number>
    lastActivity: DateTime | null
  }> {
    try {
      const startDate = DateTime.now().minus({ days })

      const activities = await UserActivity.query()
        .where('user_id', userId)
        .where('created_at', '>=', startDate.toSQL()!)
        .select('type', 'level', 'created_at')

      const totalActivities = activities.length

      const activitiesByType = activities.reduce(
        (acc, activity) => {
          acc[activity.type] = (acc[activity.type] || 0) + 1
          return acc
        },
        {} as Record<ActivityType, number>
      )

      const activitiesByLevel = activities.reduce(
        (acc, activity) => {
          acc[activity.level] = (acc[activity.level] || 0) + 1
          return acc
        },
        {} as Record<ActivityLevel, number>
      )

      const lastActivity =
        activities.length > 0
          ? activities.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0].createdAt
          : null

      return {
        totalActivities,
        activitiesByType,
        activitiesByLevel,
        lastActivity,
      }
    } catch (error) {
      logger.error(`Error getting activity stats for user ${userId}:`, error)
      throw error
    }
  }

  /**
   * Limpia actividades antiguas (para mantenimiento)
   */
  @MeasureExecutionTime
  public async cleanupOldActivities(daysToKeep: number = 90): Promise<number> {
    try {
      const cutoffDate = DateTime.now().minus({ days: daysToKeep })

      const result = await UserActivity.query()
        .where('created_at', '<', cutoffDate.toSQL()!)
        .delete()

      const deletedCount = Array.isArray(result) ? result.length : result
      logger.info(`Cleaned up ${deletedCount} old activities older than ${daysToKeep} days`)
      return deletedCount
    } catch (error) {
      logger.error('Error cleaning up old activities:', error)
      throw error
    }
  }

  /**
   * Obtiene actividades de error para debugging
   */
  @MeasureExecutionTime
  public async getErrorActivities(
    limit: number = 50,
    startDate?: DateTime
  ): Promise<UserActivity[]> {
    try {
      const query = UserActivity.query()
        .where('level', 'error')
        .orderBy('created_at', 'desc')
        .limit(limit)
        .preload('user')

      if (startDate) {
        query.where('created_at', '>=', startDate.toSQL()!)
      }

      return await query.exec()
    } catch (error) {
      logger.error('Error getting error activities:', error)
      throw error
    }
  }

  /**
   * Registra un login de usuario
   */
  public async logLogin(
    userId: number,
    ipAddress?: string,
    userAgent?: string
  ): Promise<UserActivity> {
    return this.logActivity({
      userId,
      type: 'login',
      action: 'User logged in',
      level: 'info',
      ipAddress,
      userAgent,
    })
  }

  /**
   * Registra un logout de usuario
   */
  public async logLogout(userId: number): Promise<UserActivity> {
    return this.logActivity({
      userId,
      type: 'logout',
      action: 'User logged out',
      level: 'info',
    })
  }

  /**
   * Registra un error
   */
  public async logError(
    userId: number,
    action: string,
    error: Error,
    metadata?: Record<string, any>
  ): Promise<UserActivity> {
    return this.logActivity({
      userId,
      type: 'error',
      action,
      level: 'error',
      description: error.message,
      metadata: {
        ...metadata,
        stack: error.stack,
      },
    })
  }

  /**
   * Registra una llamada a la API
   */
  public async logApiCall(
    userId: number,
    endpoint: string,
    statusCode: number,
    responseTime: number,
    userAgent?: string,
    ipAddress?: string
  ): Promise<UserActivity> {
    return this.logActivity({
      userId,
      type: 'api_call',
      action: `API call to ${endpoint}`,
      level: statusCode >= 400 ? 'error' : statusCode >= 300 ? 'warning' : 'info',
      endpoint,
      statusCode,
      responseTime,
      userAgent,
      ipAddress,
    })
  }
}
