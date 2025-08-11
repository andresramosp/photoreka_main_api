import { DescriptionType } from '#models/photo'
import Photo from '#models/photo'
import { AnalyzerTask } from './analyzerTask.js'
import PhotoImage from './photoImage.js'
import AnalyzerProcess from './analyzerProcess.js'
import { MediaResolution } from '@google/genai'

type PromptFunction = (photos: Photo[]) => string
type Prompt = string | PromptFunction

export abstract class VisionTask extends AnalyzerTask {
  declare prompts: Prompt[]
  declare resolution: 'low' | 'high' | 'medium'
  declare sequential: boolean
  declare imagesPerBatch: number
  declare promptDependentField: DescriptionType
  declare promptsNames: DescriptionType[]
  declare data: Record<number | string, Record<string, string>>
  declare complete: boolean
  declare analyzerProcess: AnalyzerProcess
  failedRequests: PhotoImage[] = []

  async process(pendingPhotos: PhotoImage[], analyzerProcess: AnalyzerProcess): Promise<void> {
    this.analyzerProcess = analyzerProcess
    if (analyzerProcess.isFastMode || pendingPhotos.length < 10) {
      await this.processWithDirectAPI(pendingPhotos)
    } else {
      await this.processWithBatchAPI(pendingPhotos)
    }
  }

  protected async executeModelTask(prompts: string[], batch: PhotoImage[]): Promise<any> {
    const prompt = prompts[0]

    if (this.model === 'GPT') {
      const images = batch.map((pp) => ({
        type: 'image_url',
        image_url: {
          url: pp.photo.originalUrl,
          detail: this.resolution,
        },
      }))
      return await this.modelsService.getGPTResponse(prompt, images, 'gpt-5-chat-latest', null, 0)
    } else if (this.model === 'Qwen') {
      const images = batch.map((pp) => ({
        type: 'image_url',
        image_url: {
          url: pp.photo.originalUrl,
          detail: this.resolution,
        },
      }))
      return await this.modelsService.getQwenResponse(prompt, images, 'qwen-vl-max', null, 0)
    } else if (this.model === 'Gemini') {
      let images = batch.map((pp) => ({
        inlineData: {
          mimeType: 'image/png',
          data: pp.base64,
        },
      }))

      return await this.modelsService.getGeminiResponse(prompt, images, this.modelName, {
        temperature: 0.1,
        mediaResolution:
          this.resolution == 'high'
            ? MediaResolution.MEDIA_RESOLUTION_HIGH
            : MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      })
    } else {
      throw new Error(`Modelo no soportado: ${this.model}`)
    }
  }

  protected sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // Métodos abstractos que cada subclase debe implementar
  abstract processWithDirectAPI(pendingPhotos: PhotoImage[]): Promise<void>
  abstract processWithBatchAPI(pendingPhotos: PhotoImage[]): Promise<void>
  abstract commit(batch: PhotoImage[]): Promise<void>
}
