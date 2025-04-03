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
