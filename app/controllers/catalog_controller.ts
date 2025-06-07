import type { HttpContext } from '@adonisjs/core/http'

import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import crypto from 'crypto'
import Photo from '#models/photo'
import { GoogleAuthService } from '#services/google_photos_service'
import PhotoManager from '../managers/photo_manager.js'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { invalidateCache } from '../decorators/withCache.js'
import ModelsService from '#services/models_service'
import PhotoImageService from '#services/photo_image_service'
import EmbeddingsService from '#services/embeddings_service'
import AnalyzerProcessRunner from '#services/analyzer_service'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})

export default class CatalogController {
  public async uploadLocal({ request, response }: HttpContext) {
    try {
      const { fileType } = request.only(['fileType'])
      if (!fileType) {
        return response.badRequest({ message: 'Falta fileType' })
      }

      const id = crypto.randomUUID()
      const extension = fileType.includes('jpeg') ? '.jpg' : '.png'
      const key = `${id}${extension}`
      const thumbnailKey = `${id}-thumb${extension}`

      // Comando para original
      const originalCommand = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: fileType,
      })

      // Comando para thumbnail
      const thumbnailCommand = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: thumbnailKey,
        ContentType: fileType,
      })

      const [uploadUrl, thumbnailUploadUrl] = await Promise.all([
        getSignedUrl(s3, originalCommand, { expiresIn: 3600 }),
        getSignedUrl(s3, thumbnailCommand, { expiresIn: 3600 }),
      ])

      // Guarda en base de datos
      const photo = await Photo.create({
        name: key,
        thumbnailName: thumbnailKey,
      })

      await invalidateCache(`getPhotos_${1234}`)
      await invalidateCache(`getPhotosIdsByUser_${1234}`)

      return response.ok({
        uploadUrl,
        thumbnailUploadUrl,
        photo,
      })
    } catch (error) {
      console.error('Error generando URLs firmadas:', error)
      return response.internalServerError({ message: 'Error generando URLs' })
    }
  }

  // public async confirmUpload({ request, response }: HttpContext) {
  //   try {
  //     const { photoId } = request.only(['photoId'])
  //     const photo = await Photo.findOrFail(photoId)

  //     // Aquí podrías generar y subir un thumbnail si lo deseas
  //     // (con sharp desde la URL ya subida o usando otra función)

  //     photo.isUploaded = true // marca como confirmada si tienes este campo
  //     await photo.save()

  //     return response.ok({ message: 'Subida confirmada' })
  //   } catch (error) {
  //     console.error('Error confirmando subida:', error)
  //     return response.internalServerError({ message: 'Error confirmando subida' })
  //   }
  // }

  // public async uploadGooglePhotos({ request, response }: HttpContext) {
  //   try {
  //     const photos = request.input('photos')
  //     if (!photos || photos.length === 0) {
  //       return response.badRequest({ message: 'No se recibieron fotos de Google Photos' })
  //     }

  //     const photosData = await Promise.all(
  //       photos.map(async (photo: Photo) => {
  //         const res = await fetch(`${photo.baseUrl}=w2000-h2000-no`) // 🔹 Obtiene la mejor calidad disponible
  //         const buffer = await res.arrayBuffer()
  //         return {
  //           buffer: Buffer.from(buffer),
  //           filename: photo.name,
  //           url: photo.baseUrl,
  //         }
  //       })
  //     )

  //     const savedPhotos = await this.savePhotos(photosData)

  //     invalidateCache(`getPhotos_${1234}`)
  //     invalidateCache(`getPhotosIdsByUser_${1234}`)

  //     return response.ok({
  //       message: 'Fotos de Google Photos guardadas exitosamente',
  //       savedPhotos,
  //     })
  //   } catch (error) {
  //     console.error('Error guardando fotos de Google Photos:', error)
  //     return response.internalServerError({
  //       message: 'Error procesando las imágenes de Google Photos',
  //     })
  //   }
  // }

  public async getPhoto({ response, request, params }: HttpContext) {
    const photoManager = new PhotoManager()
    const id = params.id
    try {
      const photo = await photoManager.getPhoto(id)
      return response.ok(photo)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async getPhotos({ response }: HttpContext) {
    const photoManager = new PhotoManager()
    try {
      const photos = await photoManager.getPhotosPreview('1234')
      return response.ok({ photos })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async getPhotosByIds({ response, request }: HttpContext) {
    const photoManager = new PhotoManager()
    try {
      const query = request.body()
      const result = await photoManager.getPhotosByIds(query.photosIds)
      return response.ok(result)
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async syncGooglePhotos({ response }: HttpContext) {
    try {
      const authUrl = await GoogleAuthService.getAuthUrl()
      return response.ok({ authUrl })
    } catch (error) {
      console.error('Error en syncGooglePhotos:', error)
      return response.internalServerError({ message: 'Error sincronizando con Google Photos' })
    }
  }

  public async callbackGooglePhotos({ request, response }: HttpContext) {
    try {
      const code = request.input('code')
      if (!code) {
        return response.badRequest({ message: 'Falta el código de autorización' })
      }

      const accessToken = await GoogleAuthService.getAccessToken(code)
      return response.redirect(`http://localhost:3000/catalog/photos?access_token=${accessToken}`)
    } catch (error) {
      console.error('Error en el callback de Google:', error)
      return response.internalServerError({ message: 'Error en la autenticación de Google Photos' })
    }
  }

  public async deletePhoto({ params, response }: HttpContext) {
    try {
      const photoManager = new PhotoManager()
      const result = await photoManager.deletePhoto(params.id)
      return response.ok(result)
    } catch (error) {
      console.error('Error al eliminar foto:', error)
      return response.internalServerError({ message: 'Error eliminando la foto' })
    }
  }

  public async checkDuplicates({ request, response }: HttpContext) {
    const { newPhotoIds } = request.only(['newPhotoIds'])

    const modelsService = new ModelsService()
    const embeddingService = new EmbeddingsService()

    const allPhotos = await Photo.all()
    const photosWithoutEmbedding = allPhotos.filter((p) => !p.embedding)

    // 1. Generar embeddings para las fotos que no lo tengan
    if (photosWithoutEmbedding.length > 0) {
      const payload = await Promise.all(
        photosWithoutEmbedding.map(async (p) => {
          const buffer = await PhotoImageService.getInstance().getImageBufferFromR2(p.name)
          const base64 = buffer.toString('base64')
          return { id: p.id, base64 }
        })
      )

      const { embeddings } = await modelsService.getEmbeddingsImages(payload)

      await Promise.all(
        embeddings.map(async (item: { id: number; embedding: number[] }) => {
          const photo = allPhotos.find((p) => p.id === item.id)
          if (photo) {
            photo.embedding = item.embedding
            await photo.save()
          }
        })
      )
    }

    // 2. Selección de fotos nuevas
    const newPhotos =
      !newPhotoIds || newPhotoIds.length === 0
        ? allPhotos
        : allPhotos.filter((p) => newPhotoIds.includes(p.id))

    const results: Record<string, string[]> = {}

    // 3. Buscar duplicados usando similitud de embeddings
    for (const newPhoto of newPhotos) {
      if (!newPhoto.embedding) continue

      const similarPhotos = await embeddingService.findSimilarPhotoToEmbedding(
        EmbeddingsService.getParsedEmbedding(newPhoto.embedding)!!,
        0.95,
        20,
        'cosine_similarity'
      )

      const matches = similarPhotos
        .filter((match: any) => match.id !== newPhoto.id)
        .map((match: any) => match.id)

      if (matches.length > 0) {
        results[newPhoto.id] = matches
      }
    }

    return response.ok(results)
  }

  public async deleteDuplicates({ request, response }: HttpContext) {
    try {
      const photoManager = new PhotoManager()
      const analyzerService = new AnalyzerProcessRunner()

      const { duplicates }: { duplicates: number[] } = request.only(['duplicates'])
      if (!duplicates || duplicates.length < 2) {
        return response.badRequest({
          message: 'Se necesitan al menos dos fotos para comparar duplicados',
        })
      }

      const healthReports = await Promise.all(
        duplicates.map(async (id) => ({
          id,
          ...(await analyzerService.photoHealth(id)),
        }))
      )

      // Ordenar: primero por `ok` (false antes que true), luego por longitud de `missing`
      const sorted = healthReports.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? 1 : -1
        return b.missing.length - a.missing.length
      })

      // Mantener la más sana (última), borrar el resto
      const toDelete = sorted.slice(0, -1)
      const deleted: number[] = []
      for (const photo of toDelete) {
        await photoManager.deletePhoto(photo.id)
        deleted.push(photo.id)
      }

      return response.ok({
        message: 'Duplicados eliminados',
        kept: sorted.at(-1)!.id,
        deleted,
      })
    } catch (error) {
      console.error('Error eliminando duplicados:', error)
      return response.internalServerError({ message: 'Error eliminando duplicados' })
    }
  }
}
