/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import path from 'path'
import { existsSync } from 'node:fs'
import router from '@adonisjs/core/services/router'
import { normalize } from 'node:path'
import { getUploadPath } from '../app/utils/dataPath.js'

const PATH_TRAVERSAL_REGEX = /(?:^|[\\/])\.\.(?:[\\/]|$)/

router.get('/uploads/photos/:filename', async ({ params, response }) => {
  const filename = params.filename
  const normalized = normalize(filename)

  if (PATH_TRAVERSAL_REGEX.test(normalized)) {
    return response.badRequest('Ruta malformada')
  }

  const basePath = getUploadPath()

  const absolutePath = path.join(basePath, normalized)

  if (!existsSync(absolutePath)) {
    return response.notFound('Archivo no encontrado')
  }

  return response.download(absolutePath)
})

const AnalyzerController = () => import('#controllers/analyzer_controller')
const CatalogController = () => import('#controllers/catalog_controller')
const SearchController = () => import('#controllers/search_controller')
const TagsController = () => import('#controllers/tags_controller')

router.get('/api/catalog', [CatalogController, 'getPhotos'])
router.post('/api/catalog/photosByIds', [CatalogController, 'getPhotosByIds'])
router.get('/api/catalog/google/sync', [CatalogController, 'syncGooglePhotos'])
router.get('/api/catalog/google/callback', [CatalogController, 'callbackGooglePhotos'])
router.post('/api/catalog/uploadLocal', [CatalogController, 'uploadLocal'])
router.post('/api/catalog/uploadGooglePhotos', [CatalogController, 'uploadGooglePhotos'])

router.post('/api/analyzer/', [AnalyzerController, 'analyze'])

router.post('/api/search/semantic', [SearchController, 'searchSemantic'])
router.post('/api/search/tags', [SearchController, 'searchByTags'])
router.post('/api/search/topological', [SearchController, 'searchTopological'])
router.post('/api/search/byPhotos', [SearchController, 'searchByPhotos'])

router.get('/api/tags/search', [TagsController, 'search'])
