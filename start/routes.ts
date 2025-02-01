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
// const TagsController = () => import('#controllers/tags_controller')

router.post('/api/analyzer/', [AnalyzerController, 'analyze'])
router.post('/api/catalog/upload', [CatalogController, 'upload'])
router.get('/api/catalog', [CatalogController, 'getPhotos'])
router.post('/api/search', [SearchController, 'search'])

// router.get('/api/tags/', [TagsController, 'list'])
// router.get('/api/tags/search', [TagsController, 'search'])
