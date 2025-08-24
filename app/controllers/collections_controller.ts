import type { HttpContext } from '@adonisjs/core/http'
import Collection from '#models/collection'
import Photo from '#models/photo'
import { inject } from '@adonisjs/core'

@inject()
export default class CollectionsController {
  /**
   * Obtener todas las colecciones del usuario autenticado
   */
  async index({ auth, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any

      const collections = await Collection.query()
        .where('userId', user.id)
        .preload('photos')
        .orderBy('createdAt', 'desc')

      // Formatear la respuesta para incluir información básica de las fotos
      const formattedCollections = collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
        photosCount: collection.photos.length,
        photos: collection.photos.map((photo) => ({
          id: photo.id,
          name: photo.name,
          originalFileName: photo.originalFileName,
          thumbnailUrl: photo.thumbnailUrl,
          originalUrl: photo.originalUrl,
          descriptions: {
            visualAspects: photo.descriptions?.visual_aspects || [],
            artisticScores: photo.descriptions?.artistic_scores || [],
          },
        })),
      }))

      return response.ok(formattedCollections)
    } catch (error) {
      return response.badRequest('Error fetching collections')
    }
  } /**
   * Obtener una colección específica
   */
  async show({ auth, params, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const collectionId = params.id

      const collection = await Collection.query()
        .where('id', collectionId)
        .where('userId', user.id)
        .preload('photos')
        .first()

      if (!collection) {
        return response.notFound('Collection not found')
      }

      const formattedCollection = {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
        photos: collection.photos.map((photo) => ({
          id: photo.id,
          name: photo.name,
          originalFileName: photo.originalFileName,
          thumbnailUrl: photo.thumbnailUrl,
          originalUrl: photo.originalUrl,
          title: photo.title,
          descriptions: photo.descriptions,
        })),
      }

      return response.ok(formattedCollection)
    } catch (error) {
      return response.badRequest('Error fetching collection')
    }
  }

  /**
   * Crear una nueva colección
   */
  async store({ auth, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const { name, description, photoIds } = request.only(['name', 'description', 'photoIds'])

      if (!name || name.trim().length === 0) {
        return response.badRequest('Collection name is required')
      }

      // Crear la colección
      const collection = await Collection.create({
        userId: user.id,
        name: name.trim(),
        description: description?.trim() || null,
      })

      // Si se proporcionaron fotos iniciales, añadirlas a la colección
      if (photoIds && Array.isArray(photoIds) && photoIds.length > 0) {
        // Verificar que las fotos pertenecen al usuario
        const photos = await Photo.query().whereIn('id', photoIds).where('userId', user.id)

        if (photos.length !== photoIds.length) {
          return response.badRequest('Some photos not found or do not belong to user')
        }

        // Usar la relación many-to-many para asociar las fotos
        await collection.related('photos').attach(photoIds)
      }

      // Cargar la colección con sus fotos para devolverla
      await collection.load('photos')

      const formattedCollection = {
        id: collection.id,
        name: collection.name,
        description: collection.description,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
        photos: collection.photos.map((photo) => ({
          id: photo.id,
          name: photo.name,
          originalFileName: photo.originalFileName,
          thumbnailUrl: photo.thumbnailUrl,
          originalUrl: photo.originalUrl,
        })),
      }

      return response.created(formattedCollection)
    } catch (error) {
      return response.badRequest('Error creating collection')
    }
  }

  /**
   * Actualizar una colección (nombre y descripción)
   */
  async update({ auth, params, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const collectionId = params.id
      const { name, description } = request.only(['name', 'description'])

      const collection = await Collection.query()
        .where('id', collectionId)
        .where('userId', user.id)
        .first()

      if (!collection) {
        return response.notFound('Collection not found')
      }

      if (!name || name.trim().length === 0) {
        return response.badRequest('Collection name is required')
      }

      collection.name = name.trim()
      collection.description = description?.trim() || null
      await collection.save()

      return response.ok({
        id: collection.id,
        name: collection.name,
        description: collection.description,
        createdAt: collection.createdAt,
        updatedAt: collection.updatedAt,
      })
    } catch (error) {
      return response.badRequest('Error updating collection')
    }
  }

  /**
   * Eliminar una colección
   */
  async destroy({ auth, params, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const collectionId = params.id

      const collection = await Collection.query()
        .where('id', collectionId)
        .where('userId', user.id)
        .first()

      if (!collection) {
        return response.notFound('Collection not found')
      }

      // Con many-to-many, primero desasociamos todas las fotos
      await collection.related('photos').detach()

      // Eliminar la colección
      await collection.delete()

      return response.ok({ message: 'Collection deleted successfully' })
    } catch (error) {
      return response.badRequest('Error deleting collection')
    }
  }

  /**
   * Añadir fotos a una colección
   */
  async addPhotos({ auth, params, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const collectionId = params.id
      const { photoIds } = request.only(['photoIds'])

      if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return response.badRequest('Photo IDs are required')
      }

      const collection = await Collection.query()
        .where('id', collectionId)
        .where('userId', user.id)
        .first()

      if (!collection) {
        return response.notFound('Collection not found')
      }

      // Verificar que las fotos pertenecen al usuario
      const photos = await Photo.query().whereIn('id', photoIds).where('userId', user.id)

      if (photos.length !== photoIds.length) {
        return response.badRequest('Some photos not found or do not belong to user')
      }

      // Cargar las fotos existentes en la colección
      await collection.load('photos')
      const existingPhotoIds = collection.photos.map((photo) => photo.id)
      const newPhotoIds = photoIds.filter((id: number) => !existingPhotoIds.includes(id))

      if (newPhotoIds.length === 0) {
        return response.badRequest('All photos are already in the collection')
      }

      // Usar la relación many-to-many para asociar las nuevas fotos
      await collection.related('photos').attach(newPhotoIds)

      return response.ok({
        message: `${newPhotoIds.length} photos added to collection`,
        addedPhotos: newPhotoIds.length,
        alreadyInCollection: existingPhotoIds.length,
      })
    } catch (error) {
      return response.badRequest('Error adding photos to collection')
    }
  }

  /**
   * Quitar fotos de una colección
   */
  async removePhotos({ auth, params, request, response }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const collectionId = params.id
      const { photoIds } = request.only(['photoIds'])

      if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
        return response.badRequest('Photo IDs are required')
      }

      const collection = await Collection.query()
        .where('id', collectionId)
        .where('userId', user.id)
        .first()

      if (!collection) {
        return response.notFound('Collection not found')
      }

      // Usar la relación many-to-many para desasociar las fotos
      await collection.related('photos').detach(photoIds)

      return response.ok({
        message: `${photoIds.length} photos removed from collection`,
        removedPhotos: photoIds.length,
      })
    } catch (error) {
      return response.badRequest('Error removing photos from collection')
    }
  }
}
