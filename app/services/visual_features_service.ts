// import Photo from '#models/photo'
// import db from '@adonisjs/lucid/services/db'
// import { createRequire } from 'module'
// const require = createRequire(import.meta.url)

// var munkres = require('munkres-js')

// interface Box {
//   x1: number
//   y1: number
//   x2: number
//   y2: number
//   // category?: string; // Si necesitas filtrar por categoría, descomenta
// }

// function computeIoU(boxA: Box, boxB: Box): number {
//   const x1 = Math.max(boxA.x1, boxB.x1)
//   const y1 = Math.max(boxA.y1, boxB.y1)
//   const x2 = Math.min(boxA.x2, boxB.x2)
//   const y2 = Math.min(boxA.y2, boxB.y2)
//   const intersectionArea = Math.max(x2 - x1, 0) * Math.max(y2 - y1, 0)
//   const boxAArea = (boxA.x2 - boxA.x1) * (boxA.y2 - boxA.y1)
//   const boxBArea = (boxB.x2 - boxB.x1) * (boxB.y2 - boxB.y1)
//   const unionArea = boxAArea + boxBArea - intersectionArea
//   return unionArea === 0 ? 0 : intersectionArea / unionArea
// }

// function createExtendedCostMatrix(targetBoxes: Box[], candidateBoxes: Box[]): number[][] {
//   const n = Math.max(targetBoxes.length, candidateBoxes.length)
//   const penalty = 1 // Penalización para casillas sin match real
//   const matrix: number[][] = []

//   for (let i = 0; i < n; i++) {
//     const row: number[] = []
//     for (let j = 0; j < n; j++) {
//       if (i < targetBoxes.length && j < candidateBoxes.length) {
//         const iou = computeIoU(targetBoxes[i], candidateBoxes[j])
//         row.push(1 - iou) // Menor costo para mayor solapamiento
//       } else {
//         row.push(penalty)
//       }
//     }
//     matrix.push(row)
//   }

//   return matrix
// }

// function computeMatchingScore(
//   targetBoxes: Box[],
//   candidateBoxes: Box[]
// ): { score: number; matching: Array<[number, number]> } {
//   const costMatrix = createExtendedCostMatrix(targetBoxes, candidateBoxes)
//   const indexes = munkres(costMatrix)
//   let totalCost = 0
//   for (const [i, j] of indexes) {
//     totalCost += costMatrix[i][j]
//   }
//   return { score: totalCost, matching: indexes }
// }

// export default class VisualFeaturesService {
//   public async findSimilarPhotosByDetections(
//     photo: Photo,
//     matchCategory: boolean = true,
//     categories: string[] = []
//   ) {
//     const photoId = photo.id

//     // 1. Recuperar detecciones de la foto target.
//     const targetDetectionsResult = await db.rawQuery(
//       `SELECT x1, y1, x2, y2 FROM detections_photos WHERE photo_id = :photoId`,
//       { photoId }
//     )
//     const targetBoxes: Box[] = targetDetectionsResult.rows.map((row: any) => ({
//       x1: row.x1,
//       y1: row.y1,
//       x2: row.x2,
//       y2: row.y2,
//     }))

//     if (targetBoxes.length === 0) {
//       // Si la foto target no tiene detecciones, se retorna vacío o se maneja el caso según convenga.
//       return []
//     }

//     // 2. Construir el filtrado espacial para recuperar solo detecciones candidatas con solape prometedor.
//     const spatialConditions: string[] = []
//     const queryParams: any = { photoId }
//     targetBoxes.forEach((box, index) => {
//       spatialConditions.push(
//         `(x2 > :t${index}_x1 AND x1 < :t${index}_x2 AND y2 > :t${index}_y1 AND y1 < :t${index}_y2)`
//       )
//       queryParams[`t${index}_x1`] = box.x1
//       queryParams[`t${index}_x2`] = box.x2
//       queryParams[`t${index}_y1`] = box.y1
//       queryParams[`t${index}_y2`] = box.y2
//     })
//     const spatialFilter = spatialConditions.join(' OR ')

//     // 3. Recuperar detecciones de fotos candidatas aplicando el filtrado espacial y, opcionalmente, por categorías.
//     let candidateQuery = `
//       SELECT photo_id, x1, y1, x2, y2 FROM detections_photos
//       WHERE photo_id != :photoId
//       AND (${spatialFilter})
//     `
//     if (categories.length > 0) {
//       candidateQuery += ' AND category = ANY(:categories)'
//       queryParams.categories = categories
//     }
//     const candidateDetectionsResult = await db.rawQuery(candidateQuery, queryParams)

//     // Agrupar detecciones por cada foto candidata.
//     const candidateBoxesMap = new Map<number, Box[]>()
//     candidateDetectionsResult.rows.forEach((row: any) => {
//       if (!candidateBoxesMap.has(row.photo_id)) {
//         candidateBoxesMap.set(row.photo_id, [])
//       }
//       candidateBoxesMap.get(row.photo_id)?.push({
//         x1: row.x1,
//         y1: row.y1,
//         x2: row.x2,
//         y2: row.y2,
//       })
//     })

//     // 4. Para cada foto candidata, calcular el score usando el algoritmo húngaro.
//     const results: { id: number; score: number }[] = []
//     for (const [candidatePhotoId, candidateBoxes] of candidateBoxesMap.entries()) {
//       const { score } = computeMatchingScore(targetBoxes, candidateBoxes)
//       results.push({ id: candidatePhotoId, score })
//     }

//     // Ordenar las fotos candidatas de mejor a peor match (menor score indica mayor similitud).
//     results.sort((a, b) => a.score - b.score)
//     return results
//   }
// }

import Photo from '#models/photo'
import db from '@adonisjs/lucid/services/db'

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(
    photo: Photo,
    matchCategory: boolean = true,
    categories: string[] = []
  ) {
    const photoId = photo.id
    const filterByCategory = categories.length > 0

    // Si se va a filtrar por categoría, en el CTE se hace directamente sin alias
    const categoryColumn = matchCategory || filterByCategory ? ', category' : ''
    const categoryFilter = filterByCategory ? 'AND category = ANY(:categories)' : ''
    const categoryCondition = matchCategory ? 'AND dp.category = tb.category' : ''

    const query = `
      WITH target_boxes AS (
        SELECT x1, y1, x2, y2${categoryColumn}
        FROM detections_photos
        WHERE photo_id = :photoId
        ${categoryFilter}
      ),
      box_matches AS (
        SELECT
          dp.photo_id,
          SUM(
            GREATEST(LEAST(tb.x2, dp.x2) - GREATEST(tb.x1, dp.x1), 0) *
            GREATEST(LEAST(tb.y2, dp.y2) - GREATEST(tb.y1, dp.y1), 0)
          ) AS score
        FROM detections_photos dp
        JOIN target_boxes tb
          ON NOT (dp.x2 <= tb.x1 OR dp.x1 >= tb.x2 OR dp.y2 <= tb.y1 OR dp.y1 >= tb.y2)
          ${categoryCondition}
        WHERE dp.photo_id != :photoId
        GROUP BY dp.photo_id
      )
      SELECT p.*, bm.score
      FROM photos p
      JOIN box_matches bm ON p.id = bm.photo_id
      ORDER BY bm.score DESC;
    `

    const queryParameters: any = { photoId }
    if (filterByCategory) {
      queryParameters.categories = categories
    }

    const result = await db.rawQuery(query, queryParameters)
    return result.rows
  }
}
