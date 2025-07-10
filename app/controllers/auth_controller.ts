import User from '#models/user'
import {
  changePasswordValidator,
  createAuthValidator,
  createLoginValidator,
  updateProfileValidator,
} from '#validators/auth'
import { HttpContext } from '@adonisjs/core/http'

export default class AuthController {
  /**
   * Register a new user
   */
  async register({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(createAuthValidator)

      const user = await User.create({
        name: payload.name,
        email: payload.email,
        password: payload.password,
        isActive: true,
      })

      const token = await User.accessTokens.create(user, ['*'])

      return response.created({
        message: 'User registered successfully',
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isActive: user.isActive,
        },
        token: token.value!.release(),
      })
    } catch (error) {
      return response.badRequest({
        message: 'Registration failed',
        error: error.message,
      })
    }
  }

  /**
   * Login user
   */
  async login({ request, response }: HttpContext) {
    try {
      const payload = await request.validateUsing(createLoginValidator)

      const user = await User.verifyCredentials(payload.email, payload.password)

      if (!user.isActive) {
        return response.unauthorized({
          message: 'Account is inactive',
        })
      }

      const token = await User.accessTokens.create(user, ['*'])

      return response.ok({
        message: 'Login successful',
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isActive: user.isActive,
        },
        token: token.value!.release(),
      })
    } catch (error) {
      return response.unauthorized({
        message: 'Invalid credentials',
      })
    }
  }

  /**
   * Logout user - requires authentication middleware
   */
  async logout({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as unknown as User

      // Get current access token and delete it
      const currentToken = (auth.use('api').user! as any).currentAccessToken
      if (currentToken) {
        await User.accessTokens.delete(user, currentToken.identifier)
      }

      return response.ok({
        message: 'Logout successful',
      })
    } catch (error) {
      return response.badRequest({
        message: 'Logout failed',
        error: error.message,
      })
    }
  }

  /**
   * Get current user profile - requires authentication middleware
   */
  async profile({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as unknown as User

      return response.ok({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          isActive: user.isActive,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      })
    } catch (error) {
      return response.unauthorized({
        message: 'User not authenticated',
      })
    }
  }

  /**
   * Update user profile - requires authentication middleware
   */
  async updateProfile({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as unknown as User

      const payload = await request.validateUsing(updateProfileValidator)

      // Check if email is being changed and if it's already taken
      if (payload.email && payload.email !== user.email) {
        const existingUser = await User.findBy('email', payload.email)
        if (existingUser) {
          return response.badRequest({
            message: 'Email already in use',
          })
        }
      }

      // Update the user
      const updatedUser = await User.findOrFail(user.id)
      updatedUser.merge(payload)
      await updatedUser.save()

      return response.ok({
        message: 'Profile updated successfully',
        user: {
          id: updatedUser.id,
          name: updatedUser.name,
          email: updatedUser.email,
          isActive: updatedUser.isActive,
          updatedAt: updatedUser.updatedAt,
        },
      })
    } catch (error) {
      return response.badRequest({
        message: 'Profile update failed',
        error: error.message,
      })
    }
  }

  /**
   * Change password - requires authentication middleware
   */
  async changePassword({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as unknown as User

      const payload = await request.validateUsing(changePasswordValidator)

      // Verify current password
      await User.verifyCredentials(user.email, payload.currentPassword)

      // Update password
      const updatedUser = await User.findOrFail(user.id)
      updatedUser.password = payload.newPassword
      await updatedUser.save()

      return response.ok({
        message: 'Password changed successfully',
      })
    } catch (error) {
      return response.badRequest({
        message: 'Password change failed',
        error: 'Invalid current password or other error',
      })
    }
  }
}
