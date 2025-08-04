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

// Landing page endpoints (no auth required)
router.post('/api/landing/request', [LandingController, 'request'])

// Endpoints health (sin auth)
router.get('/api/analyzer/health/user', [AnalyzerController, 'healthForUser'])
router.get('/api/analyzer/health/photo', [AnalyzerController, 'healthForPhoto'])
router.get('/api/analyzer/health/process', [AnalyzerController, 'healthForProcess'])

// Protected API routes (require authentication)
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
  })
  .use(middleware.auth())

router.post('download-photo', async ({ request, response }) => {
  const urls = request.input('urls')

  // Si se pasa un solo url (string)
  if (Array.isArray(urls) && urls.length == 1) {
    try {
      const imgResponse = await axios.get(urls[0], { responseType: 'stream' })
      const filename = urls[0].split('/').pop() || 'photo.jpg'

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

  // Si se pasa un array de urls
  if (Array.isArray(urls) && urls.length > 0) {
    // CORS headers
    response.header('Access-Control-Allow-Origin', '*')
    response.header('Access-Control-Expose-Headers', 'Content-Disposition')

    response.header('Content-Disposition', 'attachment; filename="photos.zip"')
    response.header('Content-Type', 'application/zip')

    const archive = archiver('zip', { zlib: { level: 9 } })
    archive.on('error', (err) => {
      response.status(500).send('Error creating zip')
    })

    // Stream the zip archive through AdonisJS response to preserve headers
    response.stream(archive)

    // Descargar y agregar cada imagen al zip
    await Promise.all(
      urls.map(async (imgUrl: string) => {
        try {
          const imgResponse = await axios.get(imgUrl, { responseType: 'stream' })
          const filename = imgUrl.split('/').pop() || 'photo.jpg'
          archive.append(imgResponse.data, { name: filename })
        } catch (err) {
          // Si una imagen falla, la ignoramos
        }
      })
    )

    await archive.finalize()
    return
  }

  // Si no se pasa ni url ni urls
  return response.badRequest('Missing url or urls')
})
