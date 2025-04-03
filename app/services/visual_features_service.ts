import Photo from '#models/photo'

export default class VisualFeaturesService {
  public async findSimilarPhotosByDetections(photo: Photo, categories: string[] = []) {
    // Asegurarse de que la foto de referencia tenga cargadas las detecciones.
    await photo.load('detections')
    const targetBoxes = photo.detections.map((d) => ({
      x1: d.x1,
      y1: d.y1,
      x2: d.x2,
      y2: d.y2,
      category: d.category,
    }))

    if (!targetBoxes.length) return []

    // Consultar las fotos candidatas (excluyendo la foto de referencia)
    // Si se filtra por categoría, se recuperan sólo aquellas fotos que tengan detecciones
    // con alguna de las categorías indicadas.
    let candidatePhotosQuery = Photo.query().where('id', '!=', photo.id)
    if (categories.length > 0) {
      candidatePhotosQuery = candidatePhotosQuery.whereHas('detections', (query) => {
        query.whereIn('category', categories)
      })
    }
    // Preload de las detecciones de cada foto candidata.
    candidatePhotosQuery = candidatePhotosQuery.preload('detections', (query) => {
      if (categories.length > 0) {
        query.whereIn('category', categories)
      }
    })

    const candidatePhotos = await candidatePhotosQuery

    // Calcular el score para cada foto candidata usando la función de bonificación.
    const candidateScores = candidatePhotos.map((candidate) => {
      const candidateBoxes = candidate.detections.map((d) => ({
        x1: d.x1,
        y1: d.y1,
        x2: d.x2,
        y2: d.y2,
        category: d.category,
      }))
      const score = computePhotoMatchScore(targetBoxes, candidateBoxes)
      return { photo: candidate, score }
    })

    // Ordenar los candidatos de mayor a menor score.
    candidateScores.sort((a, b) => b.score - a.score)

    // Devolver los datos de la foto candidata con el score agregado.
    return candidateScores.map((item) => ({
      ...item.photo.toJSON(),
      score: item.score,
    }))
  }
}

// Funciones helper para el cómputo del score

/**
 * Calcula el área de solape entre dos cajas.
 * Cada caja se define por { x1, y1, x2, y2 }.
 */
function computeOverlapArea(boxA, boxB) {
  const overlapWidth = Math.max(0, Math.min(boxA.x2, boxB.x2) - Math.max(boxA.x1, boxB.x1))
  const overlapHeight = Math.max(0, Math.min(boxA.y2, boxB.y2) - Math.max(boxA.y1, boxB.y1))
  return overlapWidth * overlapHeight
}

/**
 * Calcula el área de una caja.
 */
function boxArea(box) {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1)
}

/**
 * Calcula un score de match entre las detecciones (bounding boxes) de la foto de referencia y las de la candidata.
 * Bonifica el solape entre cajas ponderado por la similitud en tamaño y el match en cantidad de cajas.
 *
 * @param {Array} targetBoxes - Array de cajas de la foto de referencia.
 * @param {Array} candidateBoxes - Array de cajas de la foto candidata.
 * @param {number} overlapThreshold - Umbral mínimo para considerar un solape (por defecto 10).
 * @returns {number} Score final (mayor score indica mayor similitud).
 */
function computePhotoMatchScore(targetBoxes, candidateBoxes, overlapThreshold = 10) {
  if (!targetBoxes.length || !candidateBoxes.length) return 0
  let totalMatchScore = 0
  let matchedCount = 0

  targetBoxes.forEach((tBox) => {
    const areaT = boxArea(tBox)
    if (areaT <= 0) return

    // Buscar en la candidata todas las cajas que tengan solape
    const overlaps = candidateBoxes
      .map((cBox) => {
        const overlap = computeOverlapArea(tBox, cBox)
        return { cBox, overlap }
      })
      .filter((item) => item.overlap >= overlapThreshold)

    if (!overlaps.length) return

    let sumWeightedBonus = 0
    let sumOverlap = 0
    overlaps.forEach(({ cBox, overlap }) => {
      const areaC = boxArea(cBox)
      // Factor de similitud en tamaño: 1 si las áreas son iguales y menor si difieren.
      const sizeSim = 1 - Math.abs(areaT - areaC) / Math.max(areaT, areaC)
      sumWeightedBonus += overlap * sizeSim
      sumOverlap += overlap
    })
    const matchBonus = sumOverlap > 0 ? sumWeightedBonus / sumOverlap : 0
    // Fracción del área de la caja de referencia cubierta por solape.
    const areaMatchFraction = Math.min(1, sumOverlap / areaT)
    const targetBoxScore = areaMatchFraction * matchBonus

    totalMatchScore += targetBoxScore
    matchedCount++
  })

  // Bonificación por similitud en cantidad de cajas (entre referencia y candidata)
  const countBonus =
    1 -
    Math.abs(targetBoxes.length - candidateBoxes.length) /
      Math.max(targetBoxes.length, candidateBoxes.length)
  const averageMatchScore = matchedCount > 0 ? totalMatchScore / matchedCount : 0

  // Score final combinando ambos componentes
  return 0.7 * averageMatchScore + 0.3 * countBonus
}

// public async findSimilarPhotosByDetections(
//   photo: Photo,
//   matchCategory: boolean = true,
//   categories: string[] = []
// ) {
//   const photoId = photo.id
//   const filterByCategory = categories.length > 0

//   // Si se va a filtrar por categoría, en el CTE se hace directamente sin alias
//   const categoryColumn = matchCategory || filterByCategory ? ', category' : ''
//   const categoryFilter = filterByCategory ? 'AND category = ANY(:categories)' : ''
//   const categoryCondition = matchCategory ? 'AND dp.category = tb.category' : ''

//   const query = `
//     WITH target_boxes AS (
//       SELECT x1, y1, x2, y2${categoryColumn}
//       FROM detections_photos
//       WHERE photo_id = :photoId
//       ${categoryFilter}
//     ),
//     box_matches AS (
//       SELECT
//         dp.photo_id,
//         SUM(
//           GREATEST(LEAST(tb.x2, dp.x2) - GREATEST(tb.x1, dp.x1), 0) *
//           GREATEST(LEAST(tb.y2, dp.y2) - GREATEST(tb.y1, dp.y1), 0)
//         ) AS score
//       FROM detections_photos dp
//       JOIN target_boxes tb
//         ON NOT (dp.x2 <= tb.x1 OR dp.x1 >= tb.x2 OR dp.y2 <= tb.y1 OR dp.y1 >= tb.y2)
//         ${categoryCondition}
//       WHERE dp.photo_id != :photoId
//       GROUP BY dp.photo_id
//     )
//     SELECT p.*, bm.score
//     FROM photos p
//     JOIN box_matches bm ON p.id = bm.photo_id
//     ORDER BY bm.score DESC;
//   `

//   const queryParameters: any = { photoId }
//   if (filterByCategory) {
//     queryParameters.categories = categories
//   }

//   const result = await db.rawQuery(query, queryParameters)
//   return result.rows
// }
