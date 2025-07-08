// app/controllers/analyzer_process_controller.ts
import AnalyzerProcess from '#models/analyzer/analyzerProcess'
import type { HttpContext } from '@adonisjs/core/http'

export default class AnalyzerProcessController {
  public async getAll({ response }: HttpContext) {
    const processes = await AnalyzerProcess.query().preload('photos')
    return response.ok(processes)
  }

  public async getById({ params, response }: HttpContext) {
    const process = await AnalyzerProcess.query().where('id', params.id).preload('photos').first()

    if (!process) {
      return response.notFound({ message: 'AnalyzerProcess not found' })
    }

    return response.ok(process)
  }
}
