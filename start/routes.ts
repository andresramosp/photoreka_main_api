/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
const AnalyzerController = () => import('#controllers/analyzer_controller')
const CatalogController = () => import('#controllers/catalog_controller')
const SearchController = () => import('#controllers/search_controller')
const TagsController = () => import('#controllers/tags_controller')

router.get('/api/catalog', [CatalogController, 'getPhotos'])
router.get('/api/catalog/google/sync', [CatalogController, 'syncGooglePhotos'])
router.get('/api/catalog/google/callback', [CatalogController, 'callbackGooglePhotos'])
router.post('/api/catalog/uploadLocal', [CatalogController, 'uploadLocal'])
router.post('/api/catalog/uploadGooglePhotos', [CatalogController, 'uploadGooglePhotos'])

router.post('/api/analyzer/', [AnalyzerController, 'analyze'])

router.post('/api/search', [SearchController, 'search'])
router.post('/api/searchByTags', [SearchController, 'searchByTags'])

router.get('/api/tags/search', [TagsController, 'search'])

// router.get('/api/tags/', [TagsController, 'list'])
// router.get('/api/tags/search', [TagsController, 'search'])
