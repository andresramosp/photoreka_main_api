import type { HttpContext } from '@adonisjs/core/http'

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'crypto'
import Photo from '#models/photo'
import PhotoManager from '../managers/photo_manager.js'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { invalidateCache } from '../decorators/withCache.js'
import VectorService from '#services/vector_service'
import ModelsService from '#services/models_service'

import HealthPhotoService from '#services/health_photo_service'
import { MESSAGE_PHOTO_INSIGHTS } from '../utils/prompts/descriptions.js'
import PhotoImageService from '#services/photo_image_service'

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY!,
    secretAccessKey: process.env.R2_SECRET_KEY!,
  },
})

export default class CatalogController {
  /**
   * Genera URLs firmadas para subir a R2
   */
  private async generateSignedUrls(key: string, thumbnailKey: string, contentType: string) {
    const originalCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      ContentType: contentType,
    })

    const thumbnailCommand = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: thumbnailKey,
      ContentType: contentType,
    })

    return Promise.all([
      getSignedUrl(s3, originalCommand, { expiresIn: 3600 }),
      getSignedUrl(s3, thumbnailCommand, { expiresIn: 3600 }),
    ])
  }

  /**
   * Genera claves únicas para las fotos
   */
  private generatePhotoKeys(fileType?: string) {
    const id = crypto.randomUUID()
    const extension = fileType?.includes('jpeg')
      ? '.jpg'
      : fileType?.includes('png')
        ? '.png'
        : '.jpg'
    const key = `${id}${extension}`
    const thumbnailKey = `${id}-thumb${extension}`
    return { key, thumbnailKey, extension }
  }

  /**
   * Invalida cache del usuario
   */
  private async invalidateUserCache(userId: string) {
    await invalidateCache(`getPhotosByUser_${userId}`)
    await invalidateCache(`getPhotosIdsForSearch${userId}`)
  }

  /**
   * Unificado: Sube foto local o de Google Photos según el campo 'source'.
   * Body: { fileType, originalName, source?: 'local' | 'google', googlePhotoId? }
   */
  public async uploadPhoto({ request, response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const {
        fileType,
        originalName: originalFileName,
        source = 'local',
      } = request.only(['fileType', 'originalName', 'source'])

      if (!fileType || !originalFileName) {
        return response.badRequest({ message: 'Faltan datos' })
      }

      const { key, thumbnailKey } = this.generatePhotoKeys(fileType)
      const [uploadUrl, thumbnailUploadUrl] = await this.generateSignedUrls(
        key,
        thumbnailKey,
        fileType
      )

      // Guarda en base de datos

      const photo = await Photo.create({
        name: key,
        thumbnailName: thumbnailKey,
        originalFileName,
        userId: Number(userId),
        // source,
      })

      await this.invalidateUserCache(userId)

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

  public async getPhoto({ response, params }: HttpContext) {
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

  public async getPhotos({ response, auth }: HttpContext) {
    await auth.use('api').check()
    const user = auth.use('api').user! as any
    const userId = user.id.toString()

    const photoManager = new PhotoManager()
    try {
      const photos = await photoManager.getPhotosPreview(userId)
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

  // ...existing code...

  public async deletePhotos({ request, response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const { ids } = request.only(['ids'])
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return response.badRequest({ message: 'No photo IDs provided' })
      }

      const photoManager = new PhotoManager()
      const result = await photoManager.deletePhotos(ids, userId)
      return response.ok(result)
    } catch (error) {
      console.error('Error al eliminar fotos:', error)
      return response.internalServerError({ message: 'Error eliminando las fotos' })
    }
  }

  public async checkDuplicates({ request, response, auth }: HttpContext) {
    await auth.use('api').check()
    const user = auth.use('api').user! as any
    const userId = user.id.toString()

    const { newPhotoIds } = request.only(['newPhotoIds'])

    const vectorService = new VectorService()

    const userPhotos = await Photo.query().where('user_id', userId)

    // 2. Selección de fotos nuevas
    const newPhotos =
      !newPhotoIds || newPhotoIds.length === 0
        ? userPhotos
        : userPhotos.filter((p) => newPhotoIds.includes(p.id))

    // 3. Buscar duplicados usando similitud de embeddings (paralelizado)
    const results: Record<number, number[]> = {}

    await Promise.all(
      newPhotos.map(async (newPhoto) => {
        if (!newPhoto.embedding) return

        const similarPhotos = await vectorService.findSimilarPhotoToEmbedding(
          VectorService.getParsedEmbedding(newPhoto.embedding)!!,
          0.92,
          5,
          'cosine_similarity',
          userPhotos.map((p) => p.id)
        )

        const matches = similarPhotos
          .filter((match: any) => match.id !== newPhoto.id)
          .map((match: any) => match.id)

        if (matches.length > 0) {
          results[newPhoto.id] = matches
        }
      })
    )

    return response.ok(results)
  }

  public async deleteDuplicates({ request, response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const photoManager = new PhotoManager()

      const { duplicates }: { duplicates: number[] } = request.only(['duplicates'])
      if (!duplicates || duplicates.length < 2) {
        return response.badRequest({
          message: 'Se necesitan al menos dos fotos para comparar duplicados',
        })
      }

      const healthReports = await Promise.all(
        duplicates.map(async (id) => ({
          id,
          ...(await HealthPhotoService.photoHealth(id)),
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
        await photoManager.deletePhotos([photo.id], userId)
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

  public async photoInsight({ response, auth, params }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      let photo: Photo

      if (params.id) {
        // Si se proporciona un ID, buscar esa foto específica
        const foundPhoto = await Photo.query()
          .where('id', params.id)
          .where('user_id', userId)
          .first()

        if (!foundPhoto) {
          return response.notFound({ message: 'Foto no encontrada' })
        }
        photo = foundPhoto
      } else {
        // Si no se proporciona ID, seleccionar una foto aleatoria del usuario
        const userPhotos = await Photo.query().where('user_id', userId)

        if (userPhotos.length === 0) {
          return response.notFound({ message: 'No tienes fotos disponibles' })
        }

        const randomIndex = Math.floor(Math.random() * userPhotos.length)
        photo = userPhotos[randomIndex]
      }

      const modelsService = new ModelsService()

      const systemPrompt = MESSAGE_PHOTO_INSIGHTS

      const base64 = await PhotoImageService.getInstance().getImageBase64FromR2(photo.name, false)

      const imagePayload = {
        inlineData: {
          mimeType: 'image/png',
          data: base64,
        },
      }

      const gptResponse = await modelsService.getGeminiResponse(
        systemPrompt,
        [imagePayload],
        'gemini-2.5-flash-lite',
        {
          temperature: 0.6,
        }
      )

      // Limpiar imagen de memoria
      imagePayload.inlineData.data = ''

      let insights = []

      insights = gptResponse.result || []

      return response.ok({
        photo: {
          id: photo.id,
          originalFileName: photo.originalFileName,
          thumbnailUrl: photo.thumbnailUrl,
          originalUrl: photo.originalUrl,
        },
        ...insights,
      })
    } catch (error) {
      console.error('Error generando insights de foto:', error)
      return response.internalServerError({ message: 'Error generando insights de la foto' })
    }
  }
}
