import type { HttpContext } from '@adonisjs/core/http'
import ModelsService from '#services/models_service'
import db from '@adonisjs/lucid/services/db'
import { method } from 'lodash'

export default class ThreeDViewController {
  /**
   * Combina múltiples embeddings en uno solo usando promedio aritmético
   */
  private combineEmbeddings(embeddings: number[][]): number[] {
    if (embeddings.length === 0) {
      return []
    }

    if (embeddings.length === 1) {
      return embeddings[0]
    }

    const dimensions = embeddings[0].length
    const combined: number[] = new Array(dimensions).fill(0)

    // Sumar todos los embeddings
    for (const embedding of embeddings) {
      for (let i = 0; i < dimensions; i++) {
        combined[i] += embedding[i]
      }
    }

    // Calcular promedio
    for (let i = 0; i < dimensions; i++) {
      combined[i] = combined[i] / embeddings.length
    }

    return combined
  }
  /**
   * Endpoint para obtener fotos con coordenadas 3D basadas en un chunk de descripción
   * Body: { chunkName }
   */
  public async get3DPhotos({ request, response, auth }: HttpContext) {
    try {
      // Variable para limitar fotos en pruebas
      const fakeLimit = 200

      await auth.use('api').check()
      const user = auth.use('api').user! as any
      const userId = user.id.toString()

      const { chunkName } = request.body()

      let photosWithCategory

      // Caso especial: si chunkName es null, usar embeddings de la tabla photos
      if (chunkName === 'general') {
        photosWithCategory = await db.rawQuery(
          `
          SELECT 
            p.id,
            p.name,
            p.thumbnail_name,
            p.original_file_name,
            p.embedding
          FROM photos p
          WHERE p.user_id = :userId
            AND p.embedding IS NOT NULL
          ORDER BY p.id
        `,
          {
            userId: parseInt(userId),
          }
        )
      } else {
        // Validación para cuando chunkName no es null
        if (!chunkName) {
          return response.badRequest({ message: 'El parámetro chunkName es requerido' })
        }

        // Obtener las fotos únicas que tienen chunks de esta categoría
        photosWithCategory = await db.rawQuery(
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
        `,
          {
            chunkName,
            userId: parseInt(userId),
          }
        )
      }

      const photos = photosWithCategory.rows

      if (photos.length === 0) {
        return response.ok({
          photos: [],
          metadata: {
            chunkName,
            message: 'No se encontraron fotos con embeddings para esta categoría',
          },
        })
      }

      let vectors

      // Caso especial: si chunkName es null, usar embeddings directos de las fotos
      if (chunkName === 'general') {
        vectors = photos
          .map((photo: any) => {
            const embedding = photo.embedding ? JSON.parse(photo.embedding as string) : null

            return {
              id: photo.id,
              chunkId: null, // No hay chunk específico
              embedding,
              photoData: {
                id: photo.id,
                name: photo.name,
                thumbnailName: photo.thumbnail_name,
                originalFileName: photo.original_file_name,
                chunk: null, // No hay chunk de descripción
              },
            }
          })
          .filter((v: any) => v.embedding && v.embedding.length > 0)
      } else {
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
          ORDER BY dc.photo_id
        `,
          {
            chunkName,
            photoIds,
          }
        )

        const chunks = chunksResult.rows

        // Agrupar chunks por foto_id y combinar sus embeddings
        const photoChunksMap = new Map<number, any[]>()

        chunks.forEach((chunk: any) => {
          const photoId = chunk.photo_id
          if (!photoChunksMap.has(photoId)) {
            photoChunksMap.set(photoId, [])
          }
          photoChunksMap.get(photoId)!.push(chunk)
        })

        // Preparar vectores combinando embeddings por foto
        vectors = []

        for (const [photoId, photoChunks] of photoChunksMap.entries()) {
          const embeddings = photoChunks
            .map((chunk: any) => {
              return chunk.embedding ? JSON.parse(chunk.embedding as string) : null
            })
            .filter(Boolean)

          if (embeddings.length === 0) continue

          // Combinar embeddings de todos los chunks de esta foto
          const combinedEmbedding = this.combineEmbeddings(embeddings)

          // Buscar la información de la foto correspondiente
          const photoInfo = photos.find((p: any) => p.id === photoId)

          // Combinar todos los chunks en un solo texto para mostrar
          const combinedChunkText = photoChunks.map((chunk: any) => chunk.chunk).join(' | ')

          vectors.push({
            id: photoId,
            chunkId: null, // Ya no es relevante porque combinamos todos
            embedding: combinedEmbedding,
            photoData: {
              id: photoId,
              name: photoInfo?.name,
              thumbnailName: photoInfo?.thumbnail_name,
              originalFileName: photoInfo?.original_file_name,
              chunk: combinedChunkText,
            },
          })
        }
      }

      if (vectors.length === 0) {
        return response.ok({
          photos: [],
          metadata: {
            chunkName,
            message: 'No se encontraron embeddings válidos',
          },
        })
      }

      // Aplicar reducción dimensional
      const modelsService = new ModelsService()

      // Preparar payload para el nuevo endpoint
      const payload = {
        method: 'umap',
        umap_n_neighbors: 15,
        umap_min_dist: 2,
        umap_spread: 10.0,
        output_dims: 3,
        umap_metric: 'cosine',
        random_state: 42,

        // method: 'pca_tsne',
        // n_components: 3, // 3D para navegación
        // perplexity: 30, // vecinos efectivos (≈log(n)), bueno para ~2000 puntos
        // metric: 'cosine', // más acorde con embeddings
        // learning_rate: 200, // valor estable, evita dispersión caótica
        // n_iter: 1000, // suficiente para converger
        // init: 'pca', // inicialización más estable que aleatoria
        // random_state: 42, // reproducible
        items: vectors.map((v: any) => ({
          id: v.id.toString(),
          embedding: v.embedding,
        })),
      }

      const reductionResult = await modelsService.getReducedEmbeddings(payload)
      const reducedVectors = reductionResult.items || []

      // Crear mapa para un acceso rápido a los datos de las fotos
      const photosMap = new Map()
      vectors.forEach((vector: any) => {
        photosMap.set(vector.id, vector.photoData)
      })

      // Mapear resultados con información de fotos
      const photos3D = reducedVectors
        .map((reduced: any) => {
          const photoData = photosMap.get(parseInt(reduced.id))
          if (!photoData) return null

          return {
            id: photoData.id,
            originalFileName: photoData.originalFileName,
            thumbnailUrl: `https://pub-${process.env.R2_PUBLIC_ID}.r2.dev/${photoData.thumbnailName}`,
            chunk: photoData.chunk,
            coordinates: reduced.embedding_3d,
          }
        })
        .filter(Boolean)

      // Aplicar límite temporal para pruebas
      const finalPhotos = photos3D.slice(0, fakeLimit)

      return response.ok({
        photos: finalPhotos,
        metadata: {
          chunkName,
          vectorCount: finalPhotos.length,
          reducedCount: finalPhotos.length,
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
