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
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})
router.get('/uploads/photos/:filename', async ({ params, response }) => {
  const filename = params.filename

  try {
    const command = new GetObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: filename,
    })

    const s3Response = await s3.send(command)

    if (!s3Response.Body) {
      return response.notFound('Archivo no encontrado')
    }

    // Aserción de tipo para indicar que Body es un Readable stream
    const streamBody = s3Response.Body as Readable

    response.header('Content-Type', s3Response.ContentType || 'application/octet-stream')
    return response.stream(streamBody)
  } catch (error) {
    console.error('Error descargando desde R2:', error)
    return response.internalServerError('Error al obtener el archivo')
  }
})

const AnalyzerController = () => import('#controllers/analyzer_controller')
const CatalogController = () => import('#controllers/catalog_controller')
const SearchController = () => import('#controllers/search_controller')
const TagsController = () => import('#controllers/tags_controller')
const EmbeddingController = () => import('#controllers/embeddings_controller')

router.get('/api/catalog', [CatalogController, 'getPhotos'])
router.get('/api/catalog/:id', [CatalogController, 'getPhoto'])
router.post('/api/catalog/delete', [CatalogController, 'deletePhotos'])
router.post('/api/catalog/photosByIds', [CatalogController, 'getPhotosByIds'])
router.get('/api/catalog/google/sync', [CatalogController, 'syncGooglePhotos'])
router.get('/api/catalog/google/callback', [CatalogController, 'callbackGooglePhotos'])
router.post('/api/catalog/uploadLocal', [CatalogController, 'uploadLocal'])
// router.post('/api/catalog/uploadGooglePhotos', [CatalogController, 'uploadGooglePhotos'])
router.post('/api/catalog/checkDuplicates', [CatalogController, 'checkDuplicates'])
router.post('/api/catalog/deleteDuplicates', [CatalogController, 'deleteDuplicates'])

router.post('/api/analyzer/', [AnalyzerController, 'analyze'])
router.get('/api/analyzer/health/user', [AnalyzerController, 'healthForUser'])
router.get('/api/analyzer/health/process', [AnalyzerController, 'healthForProcess'])
router.post('/api/embeddings/', [EmbeddingController, 'getEmbeddings'])

router.get('/api/analyzer-process', [AnalyzerProcessController, 'getAll'])
router.get('/api/analyzer-process/:id', [AnalyzerProcessController, 'getById'])

router.post('/api/search/semantic', [SearchController, 'searchSemantic'])
router.post('/api/search/tags', [SearchController, 'searchByTags'])
router.post('/api/search/topological', [SearchController, 'searchTopological'])
router.post('/api/search/byPhotos', [SearchController, 'searchByPhotos'])
router.get('/api/search/warmUp', [SearchController, 'warmUp'])

router.get('/api/tags/search', [TagsController, 'search'])
