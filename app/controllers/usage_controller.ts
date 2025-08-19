import type { HttpContext } from '@adonisjs/core/http'
import UsageService from '#services/usage_service'
import type { Usage } from '#services/usage_service'

export default class UsageController {
  /**
   * Obtener el usage completo del usuario autenticado
   * GET /usage
   */
  async show({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const usage = await UsageService.getUsage(user.id)

      if (!usage) {
        return response.status(404).json({
          error: 'Usage data not found for user',
        })
      }

      return response.json({
        data: usage,
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to retrieve usage data',
      })
    }
  }

  /**
   * Obtener solo los límites base del usuario
   * GET /usage/base
   */
  async base({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const usage = await UsageService.getBaseUsage(user.id)

      if (!usage) {
        return response.status(404).json({
          error: 'Usage data not found for user',
        })
      }

      return response.json({
        data: usage,
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to retrieve base usage data',
      })
    }
  }

  /**
   * Actualizar los límites de usage del usuario
   * PUT /usage
   */
  async update({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const usageData = request.only([
        'photosLimit',
        'analyzedPhotosLimit',
        'creditsAvailable',
        'creditsUsed',
      ]) as Usage

      // Validación básica
      if (
        !usageData.photosLimit ||
        !usageData.analyzedPhotosLimit ||
        usageData.creditsAvailable === undefined ||
        usageData.creditsUsed === undefined
      ) {
        return response.status(400).json({
          error:
            'Missing required fields: photoLimit, analyzedPhotoLimit, creditsAvailable, creditsUsed',
        })
      }

      // Validar que sean números positivos
      if (
        usageData.photosLimit < 0 ||
        usageData.analyzedPhotosLimit < 0 ||
        usageData.creditsAvailable < 0 ||
        usageData.creditsUsed < 0
      ) {
        return response.status(400).json({
          error: 'All usage values must be positive numbers',
        })
      }

      await UsageService.updateUsage(user.id, usageData)

      return response.json({
        message: 'Usage updated successfully',
        data: usageData,
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to update usage data',
      })
    }
  }

  /**
   * Incrementar créditos usados
   * POST /usage/credits/increment
   */
  async incrementCredits({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const { amount } = request.only(['amount'])

      if (!amount || amount <= 0) {
        return response.status(400).json({
          error: 'Amount must be a positive number',
        })
      }

      // Verificar que tenga créditos suficientes antes de incrementar
      const hasEnoughCredits = await UsageService.hasEnoughCredits(user.id, amount)
      if (!hasEnoughCredits) {
        return response.status(400).json({
          error: 'Insufficient credits available',
        })
      }

      await UsageService.incrementCreditsUsed(user.id, amount)

      return response.json({
        message: `Successfully incremented credits used by ${amount}`,
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to increment credits',
      })
    }
  }

  /**
   * Verificar si puede subir fotos
   * GET /usage/can-upload
   */
  async canUpload({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const canUpload = await UsageService.canUploadPhotos(user.id)

      return response.json({
        canUpload,
        message: canUpload ? 'Can upload photos' : 'Photo limit reached',
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to check upload permissions',
      })
    }
  }

  /**
   * Verificar si puede analizar fotos
   * GET /usage/can-analyze
   */
  async canAnalyze({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const canAnalyze = await UsageService.canAnalyzePhotos(user.id)

      return response.json({
        canAnalyze,
        message: canAnalyze ? 'Can analyze photos' : 'Analysis limit reached',
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to check analysis permissions',
      })
    }
  }

  /**
   * Verificar si tiene créditos suficientes
   * POST /usage/check-credits
   */
  async checkCredits({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const { requiredCredits } = request.only(['requiredCredits'])

      if (!requiredCredits || requiredCredits <= 0) {
        return response.status(400).json({
          error: 'Required credits must be a positive number',
        })
      }

      const hasEnoughCredits = await UsageService.hasEnoughCredits(user.id, requiredCredits)

      return response.json({
        hasEnoughCredits,
        requiredCredits,
        message: hasEnoughCredits ? 'Sufficient credits available' : 'Insufficient credits',
      })
    } catch (error) {
      return response.status(500).json({
        error: 'Failed to check credits',
      })
    }
  }
}
