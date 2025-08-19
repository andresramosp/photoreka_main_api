import Photo from '#models/photo'
import User from '#models/user'

export enum UsageTier {
  TESTER = 'TESTER',
  PROMOTIONAL = 'PROMOTIONAL',
  BASIC = 'BASIC',
  PRO = 'PRO',
  PREMIUM = 'PREMIUM',
}

export const UsageTierLimits: Record<UsageTier, Omit<Usage, 'creditsUsed'>> = {
  [UsageTier.TESTER]: {
    photosLimit: 5000,
    analyzedPhotosLimit: 2000,
    creditsAvailable: 100,
  },
  [UsageTier.PROMOTIONAL]: {
    photosLimit: 2000,
    analyzedPhotosLimit: 500,
    creditsAvailable: 50,
  },
  [UsageTier.BASIC]: {
    photosLimit: 100,
    analyzedPhotosLimit: 50,
    creditsAvailable: 1000,
  },
  [UsageTier.PRO]: {
    photosLimit: 1000,
    analyzedPhotosLimit: 500,
    creditsAvailable: 10000,
  },
  [UsageTier.PREMIUM]: {
    photosLimit: 10000,
    analyzedPhotosLimit: 5000,
    creditsAvailable: 100000,
  },
}

export function getDefaultUsageByTier(tier: UsageTier): Usage {
  const limits = UsageTierLimits[tier]
  return {
    ...limits,
    creditsUsed: 0,
  }
}
export type Usage = {
  // Límites configurados
  photosLimit: number // Cantidad de fotos permitidas
  analyzedPhotosLimit: number // Cantidad de fotos analizadas permitidas
  creditsAvailable: number // Créditos disponibles
  creditsUsed: number // Créditos gastados

  // Datos calculados (opcionales para compatibilidad)
  photosUsage?: number // Fotos actualmente subidas
  analyzedPhotosUsage?: number // Fotos actualmente analizadas
  photosRemaining?: number // Fotos restantes por subir
  analyzedPhotosRemaining?: number // Análisis restantes
}

export default class UsageService {
  /**
   * Obtiene el usage básico del usuario desde la BD
   */
  static async getBaseUsage(userId: number): Promise<Usage | null> {
    const user = await User.findOrFail(userId)
    return user.usage
  }

  /**
   * Obtiene el usage extendido con datos calculados desde la BD
   */
  static async getUsage(userId: number): Promise<Usage | null> {
    let baseUsage = await this.getBaseUsage(userId)
    if (!baseUsage) {
      // Si el usuario no tiene usage, asignar el tier máximo y guardar
      const { UsageTier, getDefaultUsageByTier } = await import('#services/usage_service')
      baseUsage = getDefaultUsageByTier(UsageTier.TESTER)
      const user = await User.findOrFail(userId)
      user.usage = baseUsage
      await user.save()
    }

    // Obtener conteos en paralelo para mayor eficiencia
    const [photosUsageResult, photos] = await Promise.all([
      Photo.query().where('userId', userId).count('* as total'),
      Photo.query().where('userId', userId).preload('analyzerProcess'),
    ])

    const photosUsage = Number(photosUsageResult[0]?.$extras.total || 0)
    const analyzedPhotosUsage = photos.filter((photo) => photo.status === 'processed').length

    return {
      ...baseUsage,
      photosUsage,
      analyzedPhotosUsage,
      photosRemaining: Math.max(0, baseUsage.photosLimit - photosUsage),
      analyzedPhotosRemaining: Math.max(0, baseUsage.analyzedPhotosLimit - analyzedPhotosUsage),
    }
  }

  /**
   * Actualiza el usage base del usuario
   */
  static async updateUsage(userId: number, usage: Usage): Promise<void> {
    const user = await User.findOrFail(userId)
    user.usage = usage
    await user.save()
  }

  /**
   * Incrementa los créditos usados
   */
  static async incrementCreditsUsed(userId: number, amount: number): Promise<void> {
    const currentUsage = await this.getBaseUsage(userId)
    if (!currentUsage) return

    currentUsage.creditsUsed += amount
    await this.updateUsage(userId, currentUsage)
  }

  /**
   * Verifica si el usuario puede subir más fotos
   */
  static async canUploadPhotos(userId: number): Promise<boolean> {
    const usage = await this.getUsage(userId)
    if (!usage || usage.photosRemaining === undefined) return false

    return usage.photosRemaining > 0
  }

  /**
   * Verifica si el usuario puede analizar más fotos
   */
  static async canAnalyzePhotos(userId: number): Promise<boolean> {
    const usage = await this.getUsage(userId)
    if (!usage || usage.analyzedPhotosRemaining === undefined) return false

    return usage.analyzedPhotosRemaining > 0
  }

  /**
   * Verifica si el usuario tiene créditos suficientes
   */
  static async hasEnoughCredits(userId: number, requiredCredits: number): Promise<boolean> {
    const usage = await this.getBaseUsage(userId)
    if (!usage) return false

    return usage.creditsAvailable >= requiredCredits
  }
}
