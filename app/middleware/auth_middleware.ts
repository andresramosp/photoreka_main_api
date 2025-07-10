import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Auth middleware is used to authenticate HTTP requests and deny
 * access to unauthenticated users.
 */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    /**
     * Attempt authentication using the default guard (api)
     */
    await ctx.auth.use('api').authenticate()

    /**
     * Continue with the request when authentication succeeds
     */
    return next()
  }
}
