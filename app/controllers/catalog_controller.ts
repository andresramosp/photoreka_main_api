import type { HttpContext } from '@adonisjs/core/http'
import sharp from 'sharp'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import Photo from '#models/photo'
import PhotosService from '#services/photos_service'

export default class CatalogController {
  /**
   * Handle the upload of multiple photos
   */
  public async upload({ request, response }: HttpContext) {
    try {
      const uploadPath = path.join(process.cwd(), 'public/uploads/photos')
      await fs.mkdir(uploadPath, { recursive: true })
      const reqPhotos = request.files('photos')

      if (!reqPhotos || reqPhotos.length === 0) {
        return response.badRequest({ message: 'No se recibieron imágenes' })
      }

      const savedPhotos = []

      for (const _photo of reqPhotos) {
        if (!_photo.tmpPath) {
          continue
        }

        const fileName = `${Date.now()}-${_photo.clientName}`
        const outputPath = path.join(uploadPath, fileName)

        await sharp(_photo.tmpPath)
          .resize({ width: 1024, fit: 'inside' })
          .toFormat('jpeg')
          .toFile(outputPath)

        const photo = new Photo()
        photo.id = crypto.randomUUID()
        photo.name = fileName

        savedPhotos.push(photo)
      }

      await Photo.createMany(savedPhotos)

      return response.ok({
        message: 'Fotos subidas exitosamente',
        savedPhotos,
      })
    } catch (error) {
      console.error('Error subiendo fotos:', error)
      return response.internalServerError({ message: 'Error procesando las imágenes' })
    }
  }

  public async fetch({ response }: HttpContext) {
    try {
      const photos = await Photo.query().preload('tags').orderBy('id')

      return response.ok({ photos })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }

  public async search({ response, request }: HttpContext) {
    try {
      const photosService = new PhotosService()

      let result: Photo[] = []
      const query = request.body()

      const {
        results,
        cost,
        tagsExcluded,
        tagsMandatory,
        tagsRecommended,
        reasoning,
        tagsMisc,
        tagsOr,
        message,
      } = await photosService.search_gpt(query)

      return response.ok({
        tagsExcluded,
        tagsMandatory,
        tagsRecommended,
        tagsMisc,
        tagsOr,
        results,
        cost,
        message,
        reasoning,
      })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
