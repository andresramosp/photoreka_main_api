import type { HttpContext } from '@adonisjs/core/http'
import ModelsService from '#services/models_service'
import db from '@adonisjs/lucid/services/db'
import PhotoManager from '../managers/photo_manager.js'

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
      const fakeLimit = 5000

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
      } else if (chunkName === 'artistic_scores') {
        // Caso especial: usar el embedding computado de artistic_scores
        const photoManager = new PhotoManager()
        const photosFromDb = await photoManager.getPhotosFor3DView(userId, 'artistic_scores')

        // Convertir a formato compatible con el resto del código
        photosWithCategory = {
          rows: photosFromDb.map((photo) => ({
            id: photo.id,
            name: photo.name,
            thumbnail_name: photo.thumbnailName,
            original_file_name: photo.originalFileName,
            artistic_scores_embedding_computed: photo.artisticScoresEmbeddingComputed,
          })),
        }
      } else if (chunkName === 'visual_aspects') {
        // Caso especial: usar el embedding computado de visual_aspects
        const photoManager = new PhotoManager()
        const photosFromDb = await photoManager.getPhotosFor3DView(userId, 'visual_aspects')

        // Convertir a formato compatible con el resto del código
        photosWithCategory = {
          rows: photosFromDb.map((photo) => ({
            id: photo.id,
            name: photo.name,
            thumbnail_name: photo.thumbnailName,
            original_file_name: photo.originalFileName,
            visual_aspects_embedding_computed: photo.visualAspectsEmbeddingComputed,
          })),
        }
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
      } else if (chunkName === 'artistic_scores') {
        // Caso especial: usar embeddings de artistic_scores_embedding_computed
        vectors = photos
          .map((photo: any) => {
            const embedding = photo.artistic_scores_embedding_computed

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
      } else if (chunkName === 'visual_aspects') {
        // Caso especial: usar embeddings de visual_aspects_embedding_computed
        vectors = photos
          .map((photo: any) => {
            const embedding = photo.visual_aspects_embedding_computed

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
        chunkName, // Para la cache key
        userId, // Para la cache key
        method: 'umap',
        umap_n_neighbors: 20,
        umap_min_dist: 1, // Sube este valor para inflar los grupúsculos
        umap_spread: 10.0, // Sube este valor para separar más los grupos
        output_dims: 3,
        umap_metric: 'cosine',
        random_state: 42,

        // method: 'pca_tsne',
        // n_components: 3,
        // perplexity: 5, // más bajo para más grupúsculos
        // metric: 'cosine',
        // learning_rate: 50, // más bajo para agrupamientos más definidos
        // n_iter: 2500, // más iteraciones para mejor separación
        // init: 'random', // prueba también con 'pca'
        // random_state: 42,
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
      // Obtener descriptions para cada foto y filtrar propiedades
      const photoIdsForDescriptions = reducedVectors.map((reduced: any) => parseInt(reduced.id))
      let descriptionsMap = new Map()
      if (photoIdsForDescriptions.length > 0) {
        const descriptionsResult = await db.rawQuery(
          `SELECT id, descriptions FROM photos WHERE id = ANY(:photoIds)`,
          { photoIds: photoIdsForDescriptions }
        )
        descriptionsResult.rows.forEach((row: any) => {
          let filtered: any = {}
          if (row.descriptions) {
            try {
              const desc =
                typeof row.descriptions === 'string'
                  ? JSON.parse(row.descriptions)
                  : row.descriptions
              if ('visual_aspects' in desc) filtered.visual_aspects = desc.visual_aspects
              if ('artistic_scores' in desc) filtered.artistic_scores = desc.artistic_scores
            } catch {}
          }
          descriptionsMap.set(row.id, filtered)
        })
      }

      const photos3D = reducedVectors
        .map((reduced: any) => {
          const photoData = photosMap.get(parseInt(reduced.id))
          if (!photoData) return null
          const descriptions = descriptionsMap.get(photoData.id) || {}
          return {
            id: photoData.id,
            originalFileName: photoData.originalFileName,
            thumbnailUrl: `https://pub-${process.env.R2_PUBLIC_ID}.r2.dev/${photoData.thumbnailName}`,
            chunk: photoData.chunk,
            coordinates: reduced.embedding_3d,
            descriptions,
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
