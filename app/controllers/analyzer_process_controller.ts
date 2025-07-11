// app/controllers/analyzer_process_controller.ts
import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import type { HttpContext } from '@adonisjs/core/http'

export default class AnalyzerProcessController {
  public async getAll({ response, auth }: HttpContext) {
    await auth.use('api').check()
    const user = auth.use('api').user! as any
    const userId = user.id

    const processes = await AnalyzerProcess.query()
      .where('user_id', userId)
      .preload('photos')
      .orderBy('created_at', 'desc')

    return response.ok(processes)
  }

  public async getById({ params, response, auth }: HttpContext) {
    await auth.use('api').check()
    const user = auth.use('api').user! as any
    const userId = user.id

    const process = await AnalyzerProcess.query()
      .where('id', params.id)
      .where('user_id', userId)
      .preload('photos')
      .first()

    if (!process) {
      return response.notFound({ message: 'AnalyzerProcess not found' })
    }

    return response.ok(process)
  }
}
