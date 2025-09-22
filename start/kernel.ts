/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| The HTTP kernel file is used to register the middleware with the server
| or the router.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { invalidateCache } from '../app/decorators/withCache.js'

/**
 * The error handler is used to convert an exception
 * to a HTTP response.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * The server middleware stack runs middleware on all the HTTP
 * requests, even if there is no route registered for
 * the request URL.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
  () => import('@adonisjs/static/static_middleware'),
  () => import('@adonisjs/auth/initialize_auth_middleware'),
  () => import('#middleware/activity_logger_middleware'),
])

/**
 * The router middleware stack runs middleware on all the HTTP
 * requests with a registered route.
 */
router.use([() => import('@adonisjs/core/bodyparser_middleware')])

/**
 * Named middleware collection must be explicitly assigned to
 * the routes or the routes group.
 */
export const middleware = router.named({
  auth: () => import('#middleware/auth_middleware'),
})

const migrator = new MigrationRunner(db, app, {
  direction: 'up',
  dryRun: false,
})

try {
  await migrator.run()
  console.log('Migraciones ejecutadas correctamente.')
} catch (error) {
  console.error('Error ejecutando migraciones:', error)
} finally {
  await db.manager.closeAll()
}

invalidateCache()
