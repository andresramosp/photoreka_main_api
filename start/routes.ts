/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import AnalyzerProcessController from '#controllers/analyzer_process_controller'
import router from '@adonisjs/core/services/router'
import { middleware } from './kernel.js'
import axios from 'axios'
import archiver from 'archiver'
import pLimit from 'p-limit'
import Photo from '#models/photo'

// Auth routes (no middleware needed)
const AuthController = () => import('#controllers/auth_controller')
router.post('/api/auth/register', [AuthController, 'register'])
router.post('/api/auth/login', [AuthController, 'login'])

// Protected auth routes (require authentication)
router
  .group(() => {
    router.post('/api/auth/logout', [AuthController, 'logout'])
    router.get('/api/auth/profile', [AuthController, 'profile'])
    router.put('/api/auth/profile', [AuthController, 'updateProfile'])
    router.post('/api/auth/change-password', [AuthController, 'changePassword'])
  })
  .use(middleware.auth())

const AnalyzerController = () => import('#controllers/analyzer_controller')
const CatalogController = () => import('#controllers/catalog_controller')
const SearchController = () => import('#controllers/search_controller')
const TagsController = () => import('#controllers/tags_controller')
const EmbeddingController = () => import('#controllers/embeddings_controller')
const LandingController = () => import('#controllers/landing_controller')
const CollectionsController = () => import('#controllers/collections_controller')

// Landing page endpoints (no auth required)
router.post('/api/landing/request', [LandingController, 'request'])

// Endpoints health (sin auth)
router.get('/api/analyzer/health/user', [AnalyzerController, 'healthForUser'])
router.get('/api/analyzer/health/photo', [AnalyzerController, 'healthForPhoto'])
router.get('/api/analyzer/health/process', [AnalyzerController, 'healthForProcess'])

// Protected API routes (require authentication)3
router
  .group(() => {
    router.get('/api/catalog', [CatalogController, 'getPhotos'])
    router.get('/api/catalog/:id', [CatalogController, 'getPhoto'])
    router.post('/api/catalog/delete', [CatalogController, 'deletePhotos'])
    router.post('/api/catalog/photosByIds', [CatalogController, 'getPhotosByIds'])

    router.post('/api/catalog/uploadPhoto', [CatalogController, 'uploadPhoto'])

    router.post('/api/catalog/checkDuplicates', [CatalogController, 'checkDuplicates'])
    router.post('/api/catalog/deleteDuplicates', [CatalogController, 'deleteDuplicates'])

    router.post('/api/analyzer/', [AnalyzerController, 'analyze'])
    router.post('/api/embeddings/', [EmbeddingController, 'getEmbeddings'])

    router.get('/api/analyzer-process', [AnalyzerProcessController, 'getAll'])
    router.get('/api/analyzer-process/:id', [AnalyzerProcessController, 'getById'])

    router.post('/api/search/semantic', [SearchController, 'searchSemantic'])
    router.post('/api/search/tags', [SearchController, 'searchByTags'])
    router.post('/api/search/topological', [SearchController, 'searchTopological'])
    router.post('/api/search/byPhotos', [SearchController, 'searchByPhotos'])
    router.get('/api/search/warmUp', [SearchController, 'warmUp'])

    router.get('/api/tags/search', [TagsController, 'search'])

    // Collections endpoints
    router.get('/api/collections', [CollectionsController, 'index'])
    router.get('/api/collections/:id', [CollectionsController, 'show'])
    router.post('/api/collections', [CollectionsController, 'store'])
    router.put('/api/collections/:id', [CollectionsController, 'update'])
    router.delete('/api/collections/:id', [CollectionsController, 'destroy'])
    router.post('/api/collections/:id/photos', [CollectionsController, 'addPhotos'])
    router.delete('/api/collections/:id/photos', [CollectionsController, 'removePhotos'])

    // Download photos endpoint
    router.post('/download-photo', async ({ request, response }) => {
      const ids = request.input('ids')

      if (!Array.isArray(ids) || ids.length === 0) {
        return response.badRequest('Missing ids')
      }

      // Buscar las fotos en la BD y verificar que pertenecen al usuario
      const photos = await Photo.query().whereIn('id', ids)

      if (photos.length === 0) {
        return response.badRequest('No photos found for given ids')
      }

      // Si es solo una foto
      if (photos.length === 1) {
        const photo = photos[0]
        try {
          const imgResponse = await axios.get(photo.originalUrl, { responseType: 'stream' })
          const filename = photo.originalFileName || 'photo.jpg'

          // CORS headers
          response.header('Access-Control-Allow-Origin', '*')
          response.header('Access-Control-Expose-Headers', 'Content-Disposition')

          response.header('Content-Disposition', `attachment; filename="${filename}"`)
          response.header(
            'Content-Type',
            imgResponse.headers['content-type'] || 'application/octet-stream'
          )
          return response.stream(imgResponse.data)
        } catch (err) {
          response.status(500).send('Error downloading image')
        }
        return
      }

      // Si son varias fotos
      // CORS headers
      response.header('Access-Control-Allow-Origin', '*')
      response.header('Access-Control-Expose-Headers', 'Content-Disposition')

      response.header('Content-Disposition', 'attachment; filename="photos.zip"')
      response.header('Content-Type', 'application/zip')

      const archive = archiver('zip', { zlib: { level: 9 } })
      archive.on('error', () => {
        response.status(500).send('Error creating zip')
      })

      // Stream the zip archive through AdonisJS response to preserve headers
      response.stream(archive)

      // Limitar concurrencia de descargas a 3 usando p-limit
      const limit = pLimit(3)
      await Promise.all(
        photos.map((photo, idx) =>
          limit(async () => {
            try {
              console.log(
                `[ZIP] Descargando foto ${idx + 1}/${photos.length}: ${photo.originalUrl}`
              )
              const imgResponse = await axios.get(photo.originalUrl, { responseType: 'stream' })
              const filename = photo.originalFileName || `photo_${idx + 1}.jpg`
              archive.append(imgResponse.data, { name: filename })
            } catch (err) {
              console.error(`[ZIP] Error descargando o agregando foto:`, err)
              // Si una imagen falla, la ignoramos
            }
          })
        )
      )
      console.log('[ZIP] Todas las fotos agregadas, finalizando zip...')
      archive.finalize()
      response.response.on('close', () => {
        console.log('[ZIP] Zip finalizado y enviado')
      })
      return
    })
  })
  .use(middleware.auth())
