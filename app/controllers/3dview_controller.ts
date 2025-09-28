import type { HttpContext } from '@adonisjs/core/http'
import DimensionalReductionService from '#services/3dview_service'
import db from '@adonisjs/lucid/services/db'

export default class ThreeDViewController {
  /**
   * Endpoint para obtener fotos con coordenadas 3D basadas en un chunk de descripción
   * Body: { chunkName, page?, limit?, method? }
   */
  public async get3DPhotos({ request, response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const { chunkName, page = 1, limit = 50, method = 'pca' } = request.body()

      // Validaciones básicas
      if (!chunkName) {
        return response.badRequest({ message: 'El parámetro chunkName es requerido' })
      }

      const pageNum = parseInt(page)
      const limitNum = Math.min(parseInt(limit), 200) // Máximo 200 fotos por página
      const offset = (pageNum - 1) * limitNum

      if (pageNum < 1 || limitNum < 1) {
        return response.badRequest({ message: 'Los parámetros page y limit deben ser mayores a 0' })
      }

      // Primero obtener las fotos únicas que tienen chunks de esta categoría (con paginación)
      const photosWithCategory = await db.rawQuery(
        `
        SELECT DISTINCT
          p.id,
          p.name,
          p.thumbnail_name,
          p.original_file_name
        FROM photos p
        JOIN descriptions_chunks dc ON p.id = dc.photo_id
        WHERE dc.category = :chunkName
          AND p.user_id = :userId
          AND dc.embedding IS NOT NULL
        ORDER BY p.id
        OFFSET :offset
        LIMIT :limit
      `,
        {
          chunkName,
          userId: parseInt(userId),
          offset,
          limit: limitNum,
        }
      )

      const photos = photosWithCategory.rows

      if (photos.length === 0) {
        return response.ok({
          photos: [],
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: 0,
            totalPages: 0,
          },
          metadata: {
            chunkName,
            method,
            message: 'No se encontraron fotos con embeddings para esta categoría',
          },
        })
      }

      // Obtener los chunks específicos de las fotos paginadas
      const photoIds = photos.map((p: any) => p.id)
      const chunksResult = await db.rawQuery(
        `
        SELECT 
          dc.id as chunk_id,
          dc.photo_id,
          dc.chunk,
          dc.embedding
        FROM descriptions_chunks dc
        WHERE dc.category = :chunkName
          AND dc.photo_id = ANY(:photoIds)
          AND dc.embedding IS NOT NULL
      `,
        {
          chunkName,
          photoIds,
        }
      )

      const chunks = chunksResult.rows

      // Preparar vectores para reducción dimensional
      const vectors = chunks
        .map((chunk: any) => {
          const embedding = chunk.embedding ? JSON.parse(chunk.embedding as string) : null
          // Buscar la información de la foto correspondiente
          const photoInfo = photos.find((p: any) => p.id === chunk.photo_id)

          return {
            id: chunk.photo_id,
            chunkId: chunk.chunk_id,
            embedding,
            photoData: {
              id: chunk.photo_id,
              name: photoInfo?.name,
              thumbnailName: photoInfo?.thumbnail_name,
              originalFileName: photoInfo?.original_file_name,
              chunk: chunk.chunk,
            },
          }
        })
        .filter((v: any) => v.embedding && v.embedding.length > 0)

      if (vectors.length === 0) {
        return response.ok({
          photos: [],
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: 0,
            totalPages: 0,
          },
          metadata: {
            chunkName,
            method,
            message: 'No se encontraron embeddings válidos',
          },
        })
      }

      // Aplicar reducción dimensional
      const dimensionalReductionService = new DimensionalReductionService()
      const reducedVectors = await dimensionalReductionService.reduce3D(
        vectors.map((v: any) => ({ id: v.id, embedding: v.embedding! }))
      )

      // Crear mapa para un acceso rápido a los datos de las fotos
      const photosMap = new Map()
      vectors.forEach((vector: any) => {
        photosMap.set(vector.id, vector.photoData)
      })

      // Mapear resultados con información de fotos
      const photos3D = reducedVectors
        .map((reduced) => {
          const photoData = photosMap.get(reduced.id)
          if (!photoData) return null

          return {
            id: photoData.id,
            originalFileName: photoData.originalFileName,
            thumbnailUrl: `https://pub-${process.env.R2_PUBLIC_ID}.r2.dev/${photoData.thumbnailName}`,
            chunk: photoData.chunk,
            coordinates: reduced.coordinates,
          }
        })
        .filter(Boolean)

      // Obtener total de fotos únicas para paginación
      const totalResult = await db.rawQuery(
        `
        SELECT COUNT(DISTINCT p.id) as total
        FROM photos p
        JOIN descriptions_chunks dc ON p.id = dc.photo_id
        WHERE dc.category = :chunkName
          AND p.user_id = :userId
          AND dc.embedding IS NOT NULL
      `,
        {
          chunkName,
          userId: parseInt(userId),
        }
      )

      const total = totalResult.rows[0]?.total || 0
      const totalPages = Math.ceil(total / limitNum)

      return response.ok({
        photos: photos3D,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
        metadata: {
          chunkName,
          method,
          vectorCount: vectors.length,
          reducedCount: photos3D.length,
        },
      })
    } catch (error) {
      console.error('Error en get3DPhotos:', error)
      return response.internalServerError({
        message: 'Error generando visualización 3D de fotos',
        error: error.message,
      })
    }
  }

  /**
   * Obtiene las categorías disponibles de chunks para un usuario
   */
  public async getAvailableCategories({ response, auth }: HttpContext) {
    try {
      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const categoriesResult = await db.rawQuery(
        `
        SELECT 
          dc.category,
          COUNT(*) as count
        FROM descriptions_chunks dc
        JOIN photos p ON dc.photo_id = p.id
        WHERE p.user_id = :userId
          AND dc.embedding IS NOT NULL
        GROUP BY dc.category
        ORDER BY count DESC
      `,
        {
          userId: parseInt(userId),
        }
      )

      const categories = categoriesResult.rows.map((row: any) => ({
        category: row.category,
        count: parseInt(row.count),
      }))

      return response.ok({
        categories,
        totalCategories: categories.length,
      })
    } catch (error) {
      console.error('Error obteniendo categorías:', error)
      return response.internalServerError({
        message: 'Error obteniendo categorías disponibles',
        error: error.message,
      })
    }
  }
}
