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
const TagsController = () => import('#controllers/tags_controller')

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.post('/api/analyzer/', [AnalyzerController, 'analyze'])
router.post('/api/catalog/upload', [CatalogController, 'upload'])
router.get('/api/catalog/', [CatalogController, 'fetch'])
router.post('/api/catalog/search_desc', [CatalogController, 'searchDesc'])
router.post('/api/catalog/search_tags', [CatalogController, 'searchTags'])

router.get('/api/tags/', [TagsController, 'list'])
