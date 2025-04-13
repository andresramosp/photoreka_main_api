import type { HttpContext } from '@adonisjs/core/http'
import Tag from '#models/tag'
import db from '@adonisjs/lucid/services/db'

export default class TagsController {
  public async list({ request, response }: HttpContext) {
    const result = await Tag.all()
    return response.ok({ result })
  }

  // TODO: por usuario!
  public async search({ request, response }: HttpContext) {
    const term = request.input('term', '').toLowerCase()
    const rawResult = await db.rawQuery(
      `
      SELECT DISTINCT ON (name) id, name, "group"
      FROM tags
      WHERE LOWER(name) LIKE ?
      ORDER BY name, created_at DESC
      `,
      [`%${term.toLowerCase()}%`]
    )

    const result = rawResult.rows.sort((a: any, b: any) => a.name.length - b.name.length)

    return response.ok({ result: result })
  }
}
