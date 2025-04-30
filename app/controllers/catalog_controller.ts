// @ts-nocheck

import type { HttpContext } from '@adonisjs/core/http'
import sharp from 'sharp'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'
import Photo from '#models/photo'
import { GoogleAuthService } from '#services/google_photos_service'
import PhotoManager from '../managers/photo_manager.js'
import { getUploadPath } from '../utils/dataPath.js'

export default class CatalogController {
  private async savePhotos(
    photosData: Array<{ buffer: Buffer; filename: string; url: string | undefined }>
  ) {
    const uploadPath = getUploadPath()
    await fs.mkdir(uploadPath, { recursive: true })

    const savedPhotos = []

    for (const photoData of photosData) {
      const fileName = `${Date.now()}-${photoData.filename}`
      const thumbnailName = `thumb-${fileName}`
      const outputPath = path.join(uploadPath, fileName)
      const thumbnailPath = path.join(uploadPath, thumbnailName)

      // Guardar versión original para análisis
      await sharp(photoData.buffer)
        .resize({ width: 1500, fit: 'inside' })
        .toFormat('jpeg')
        .toFile(outputPath)

      // Generar versión optimizada para visualización
      await sharp(photoData.buffer)
        .resize({ width: 800, fit: 'inside' })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath)

      const photo = new Photo()
      photo.name = fileName
      photo.thumbnailName = thumbnailName
      photo.url = photoData.url

      savedPhotos.push(photo)
    }

    await Photo.createMany(savedPhotos)
    return savedPhotos
  }

  public async uploadLocal({ request, response }: HttpContext) {
    try {
      const reqPhotos = request.files('photos')
      if (!reqPhotos || reqPhotos.length === 0) {
        return response.badRequest({ message: 'No se recibieron imágenes' })
      }

      // 🔹 Asegurar que las promesas se resuelvan antes de pasarlas a savePhotos
      const photosData = await Promise.all(
        reqPhotos.map(async (photo) => ({
          buffer: await fs.readFile(photo.tmpPath!),
          filename: photo.clientName,
        }))
      )

      const savedPhotos = await this.savePhotos(photosData)

      return response.ok({
        message: 'Fotos subidas exitosamente',
        savedPhotos,
      })
    } catch (error) {
      console.error('Error subiendo fotos:', error)
      return response.internalServerError({ message: 'Error procesando las imágenes' })
    }
  }

  public async uploadGooglePhotos({ request, response }: HttpContext) {
    try {
      const photos = request.input('photos')
      if (!photos || photos.length === 0) {
        return response.badRequest({ message: 'No se recibieron fotos de Google Photos' })
      }

      const photosData = await Promise.all(
        photos.map(async (photo) => {
          const res = await fetch(`${photo.baseUrl}=w2000-h2000-no`) // 🔹 Obtiene la mejor calidad disponible
          const buffer = await res.arrayBuffer()
          return {
            buffer: Buffer.from(buffer),
            filename: photo.filename,
            url: photo.baseUrl,
          }
        })
      )

      const savedPhotos = await this.savePhotos(photosData)

      return response.ok({
        message: 'Fotos de Google Photos guardadas exitosamente',
        savedPhotos,
      })
    } catch (error) {
      console.error('Error guardando fotos de Google Photos:', error)
      return response.internalServerError({
        message: 'Error procesando las imágenes de Google Photos',
      })
    }
  }

  public async getPhotos({ response }: HttpContext) {
    const photoManager = new PhotoManager()
    try {
      const photos = await photoManager.getPhotos('1234', true)
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
}
