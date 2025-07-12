import type { HttpContext } from '@adonisjs/core/http'
import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'

export default class TagsController {
  public async list({ request, response, auth }: HttpContext) {
    const user = auth.use('api').user!

    if (!user) {
      return response.unauthorized({ message: 'User not authenticated' })
    }

    const result = await Tag.all()
    return response.ok({ result })
  }

  // Buscar tags asociados a las fotos del usuario
  public async search({ request, response, auth }: HttpContext) {
    const user = auth.use('api').user
    if (!user) {
      return response.unauthorized({ message: 'User not authenticated' })
    }

    const term = request.input('term', '').toLowerCase()

    // Consulta: obtener los tags de las fotos del usuario
    const rawResult = await db.rawQuery(
      `
      SELECT DISTINCT ON (t.name) t.id, t.name, t."group"
      FROM photos p
      JOIN tags_photos tp ON tp.photo_id = p.id
      JOIN tags t ON t.id = tp.tag_id
      WHERE p.user_id = ?
        AND LOWER(t.name) LIKE ?
      ORDER BY t.name, t.id DESC
      `,
      [user.id, `%${term}%`]
    )

    const result = rawResult.rows.sort((a: any, b: any) => a.name.length - b.name.length)
    return response.ok({ result })
  }
}
