/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
const ImagesController = () => import('#controllers/images_controller')

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

router.post('/api/image', [ImagesController, 'processImage'])
router.get('/api/image/:filename', [ImagesController, 'getImageInfo'])
