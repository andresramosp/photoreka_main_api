import type { HttpContext } from '@adonisjs/core/http'
import sharp from 'sharp'
import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'

export default class CatalogController {
  /**
   * Handle the upload of multiple photos
   */
  public async upload({ request, response }: HttpContext) {
    try {
      // Ruta donde se guardarán las imágenes
      const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

      // Asegúrate de que la carpeta exista
      await fs.mkdir(uploadPath, { recursive: true })

      // Obtener los archivos del request
      const photos = request.files('photos')

      if (!photos || photos.length === 0) {
        return response.badRequest({ message: 'No se recibieron imágenes' })
      }

      const savedPhotos = []

      // Procesar y guardar cada archivo
      for (const photo of photos) {
        if (!photo.tmpPath) {
          continue
        }

        // Procesar la imagen con sharp y guardarla
        const fileName = `${Date.now()}-${photo.clientName}`
        const outputPath = path.join(uploadPath, fileName)

        await sharp(photo.tmpPath)
          .resize(800) // Redimensionar si es necesario
          .toFormat('jpeg') // Convertir a JPEG si es necesario
          .toFile(outputPath)

        savedPhotos.push({
          originalName: photo.clientName,
          id: crypto.randomUUID(),
          path: `/uploads/photos/${fileName}`,
        })
      }

      return response.ok({
        message: 'Fotos subidas exitosamente',
        photos: savedPhotos,
      })
    } catch (error) {
      console.error('Error subiendo fotos:', error)
      return response.internalServerError({ message: 'Error procesando las imágenes' })
    }
  }

  public async fetch({ response }: HttpContext) {
    try {
      const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

      // Verificar si la carpeta existe
      const files = await fs.readdir(uploadPath)

      // Crear URLs públicas para las fotos
      const photos = files.map((file) => ({
        originalName: file,
        id: crypto.randomUUID(),
        path: `/uploads/photos/${file}`,
      }))

      return response.ok({ photos })
    } catch (error) {
      console.error('Error fetching photos:', error)
      return response.internalServerError({ message: 'Error fetching photos' })
    }
  }
}
