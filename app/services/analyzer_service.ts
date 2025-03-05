// @ts-nocheck

const STOPWORDS = [
  'Environment',
  'Activity',
  'background',
  'Scene',
  'Atmosphere',
  'Space',
  'Structure',
  'Form',
  'Pattern',
  'Context',
  'Moment',
  'Perspective',
  'Interaction',
  'Concept',
  'Movement',
  'Detail',
  'Element',
  'Abstract',
  'Texture',
  'Contrast',
  'Shape',
  'Event',
  'Frame',
  'Action',
  'Gesture',
  'Story',
  'Symbol',
  'Composition',
  'Relation',
  'Contextual',
  'Dynamic',
  'Static',
  'Layer',
  'Experience',
  'Ambience',
  'Instance',
  'Momentary',
  'Surrounding',
  'Lifestyle',
  'Everyday',
  'Object',
  'Urbanity',
  'Timeless',
  'Visual',
  'Undefined',
  'General',
  'Subject',
  'Focus',
  'Ambiguity',
  'Conceptual',
  'Expression',
  'Scene',
  'Humanity',
  'Visuality',
  'Significance',
  'Identity',
  'Situation',
  'Artistic',
  'Dimension',
  'Simplicity',
  'Complexity',
  'Balance',
  'Tension',
  'Reality',
  'Metaphor',
  'Projection',
  'Narrative',
  'Representation',
  'Value',
  'Observation',
  'Intention',
  'Causality',
  'Meaning',
  'Interpretation',
  'Mediation',
  'Observation',
  'Presence',
  'Perception',
  'Medium',
  'Framework',
  'Alignment',
  'Essence',
  'Proportion',
  'Dynamics',
  'Mood',
  'Contextualization',
  'Overview',
  'Appreciation',
  'Objectivity',
  'Subjectivity',
  'Symbolism',
  'Resonance',
].map((word) => word.toLocaleLowerCase())

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import PhotosService from './photos_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import ModelsService from './models_service.js'
import Tag from '#models/tag'
import {
  SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY_FOR_PRETRAIN,
  SYSTEM_MESSAGE_ANALYZER_GPT_DESC,
  SYSTEM_MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED,
  SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_PRETRAINED,
  SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_GPT,
} from '../utils/ModelsMessages.js'
import { createRequire } from 'module'
import EmbeddingsService from './embeddings_service.js'
import DescriptionChunk from '#models/descriptionChunk'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import ws from './ws.js'
import NLPService from './nlp_service.js'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const lemmatizer = {
  stem: (word: string) => pluralize.singular(word.toLowerCase()),
}

export default class AnalyzerService {
  public async *analyzeGPT(photosIds: string[]) {
    const photosService = new PhotosService()
    const modelsService = new ModelsService()

    const photos = await photosService.getPhotosByIds(photosIds)
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    let photosToProcess = []
    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`)

      try {
        await fs.access(filePath)
        const resizedBuffer = await sharp(filePath).toBuffer()

        photosToProcess.push({
          id: photo.id,
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (photosToProcess.length === 0) {
      throw new Exception('No valid images found for the provided IDs')
    }

    const results = []

    // Fase GPT: Extracción de tags, fijación de contexto

    let photosProcessed = []
    const maxImagesPerBatchGPT = 6
    let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    for (let i = 0; i < photosToProcess.length; i += maxImagesPerBatchGPT) {
      const batch = photosToProcess.slice(i, i + maxImagesPerBatchGPT)

      const responseGPT = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_ANALYZER_GPT_DESC(batch),
        batch.map(({ base64 }) => ({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64}`,
            detail: 'high',
          },
        })),
        'gpt-4o',
        null,
        false
      )

      photosProcessed.push(...responseGPT.result)
      await sleep(750)
    }

    // PROVISIONAL

    photosProcessed = photosProcessed.map((photo) => ({
      id: photo.id,
      descriptionGeneric: photo.atmosphere_description,
      descriptionTopologic: photo.objects_description,
      descriptionGenre: photo.storytelling_description,
      descriptionShort: photo.context_description,
    }))

    let { photosWithDescs: photosProcessedWithTags, costs } =
      await this.addTagsFromDescs(photosProcessed)

    results.push(...photosProcessedWithTags)

    try {
      await this.processDescAndTags(results)
      yield { type: 'analysisComplete', data: { cost: costs } }
      return
    } catch (err) {}
  }

  public async *analyzeGPTAndMolmo(photosIds: string[]) {
    const photosService = new PhotosService()
    const modelsService = new ModelsService()

    const photos = await photosService.getPhotosByIds(photosIds)
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    let photosToProcess = []
    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`)

      try {
        await fs.access(filePath)
        const resizedBuffer = await sharp(filePath).toBuffer()

        photosToProcess.push({
          id: photo.id,
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (photosToProcess.length === 0) {
      throw new Exception('No valid images found for the provided IDs')
    }

    const results = []

    // Fase GPT: Contexto y story telling

    const pretrainTexts = []
    const maxImagesPerBatchGPT = 6
    let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    for (let i = 0; i < photosToProcess.length; i += maxImagesPerBatchGPT) {
      const batch = photosToProcess.slice(i, i + maxImagesPerBatchGPT)

      const responseGPT = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY_FOR_PRETRAIN(batch),
        batch.map(({ base64 }) => ({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64}`,
            detail: 'high',
          },
        })),
        'gpt-4o',
        null,
        0
      )

      pretrainTexts.push(...responseGPT.result)
      await sleep(750) // Delay antes de iniciar el siguiente batch
    }

    const photosWithPretrained = photosToProcess.map((photo) => ({
      ...photo,
      descriptionShort: pretrainTexts.find((sd) => sd.id == photo.id).context_description,
      descriptionGenre: pretrainTexts.find((sd) => sd.id == photo.id).storytelling_description,
    }))

    const batchPromisesMolmo = []
    const resultsMolmo = []
    let maxImagesPerBatchMolmo = photosWithPretrained.length

    for (let i = 0; i < photosWithPretrained.length; i += maxImagesPerBatchMolmo) {
      const batch = photosWithPretrained.slice(i, i + maxImagesPerBatchMolmo)

      let { result: photosProcessed } = await modelsService.getMolmoResponse(
        batch.map((photo) => ({ id: photo.id, base64: photo.base64 })),
        [],
        [
          ...photosWithPretrained.map((photo, index) => ({
            id: photo.id,
            prompts: [
              {
                id: 'description_topologic',
                text: SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_PRETRAINED(photo.descriptionShort),
              },
              // {
              //   id: 'description_generic',
              //   text: SYSTEM_MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED(photo.descriptionShort),
              // },
            ],
          })),
        ]
      )

      photosProcessed = photosProcessed.map((photo) => ({
        id: photo.id,
        descriptionGeneric: '',
        // photo.descriptions.find((d) => d.id_prompt == 'description_generic')
        //   .description,
        descriptionTopologic: photo.descriptions.find((d) => d.id_prompt == 'description_topologic')
          .description,
        descriptionGenre: photosWithPretrained.find((p) => photo.id == p.id).descriptionGenre,
        descriptionShort: photosWithPretrained.find((p) => photo.id == p.id).descriptionShort,
      }))

      let { photosWithDescs: photosProcessedWithTags, costs } =
        await this.addTagsFromDescs(photosProcessed)

      results.push(...photosProcessedWithTags)
    }

    try {
      await this.processDescAndTags(results)
      yield { type: 'analysisComplete', data: { cost: costs } }
      return
    } catch (err) {}
  }

  // Función sleep externa

  private async addTagsFromDescs(photosWithDescs: any[]): Promise<any[]> {
    const modelsService = new ModelsService()
    let costs: number[] = []
    const delayMs = 500

    let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const tasks = photosWithDescs.map(async (photo, index) => {
      await sleep(index * delayMs)
      const completeDescForTags = `1. Context: ${photo.descriptionShort} | 2. Story: ${photo.descriptionGenre} | 3. Topology: ${photo.descriptionTopologic} `
      const { result, cost } = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_GPT,
        JSON.stringify({ description: completeDescForTags }),
        'gpt-4o-mini'
      )

      // TODO: si no hay ningun grupo "people", añadimos un "no people"!

      const tagsDict: { [key: string]: string[] } = {}
      result.tags.forEach((tagStr: string) => {
        const [tag, group] = tagStr.split('|').map((item) => item.trim())
        if (!tagsDict[group]) {
          tagsDict[group] = []
        }
        tagsDict[group].push(tag)
      })

      costs.push(cost)
      Object.assign(photo, tagsDict)
    })

    await Promise.all(tasks)
    return { photosWithDescs, costs }
  }

  public async processDescAndTags(dictionary: { id: string; [key: string]: any }[]) {
    const existingTags = await Tag.all()
    const tagMap = new Map(
      existingTags.map((tag) => [lemmatizer.stem(tag.name.toLowerCase()), tag])
    )

    const nlpService = new NLPService()

    await Promise.all(
      dictionary.map(async (data) => {
        const {
          id,
          descriptionShort,
          descriptionGeneric,
          descriptionTopologic,
          descriptionGenre,
          ...generatedTags
        } = data

        const photo = await Photo.query().where('id', id).first()

        if (photo) {
          const updateData: any = {}
          const tagInstances: any[] = []

          await Promise.all([
            await this.createDescChunks([descriptionShort, descriptionGenre], photo.id),
            ...Object.keys(generatedTags).map(async (group) => {
              let tags = generatedTags[group] || []
              for (let tag of tags) {
                let sustantivesFromTag = nlpService.getSustantives(tag)
                if (sustantivesFromTag?.length) tags.push(...sustantivesFromTag)
              }
              await Promise.all(
                tags.map((tagName: string) => this.processTag(tagName, group, tagMap, tagInstances))
              )
            }),
          ])

          const fields = Array.from(Photo.$columnsDefinitions.keys())
          fields.forEach((key) => {
            if (generatedTags[key]) {
              updateData[key] = generatedTags[key]
              delete generatedTags[key]
            }
          })

          photo.merge({
            ...updateData,
            descriptionShort,
            descriptionGeneric,
            descriptionGenre: '',
            descriptionTopologic,
            descriptionGenre,
            processed: true,
            model: 'Molmo',
          })

          await photo.save()

          // 🔹 Enviamos un evento WebSocket inmediatamente tras guardar la foto
          ws.io?.emit('photoProcessed', { id: photo.id })

          if (tagInstances.length > 0) {
            const uniqueTagInstances = Array.from(
              new Map(tagInstances.map((tag) => [tag.name.toLowerCase(), tag])).values()
            )

            await photo.related('tags').sync(
              uniqueTagInstances.map((tag) => tag.id),
              true
            )
          }
        }
      })
    )
  }

  @MeasureExecutionTime
  public async createDescChunks(desc: string | string[], photoId: string) {
    const modelsService = new ModelsService()

    // Si 'desc' es un array, concatenar sus elementos, sino se usa directamente
    const fullDesc = Array.isArray(desc) ? desc.join(' | ') : desc

    // Dividir el texto en fragmentos de tamaño similar, terminando en puntos
    const splitChunks = this.splitIntoChunks(fullDesc, fullDesc.length / 350)

    for (const chunk of splitChunks) {
      const { embeddings } = await modelsService.getEmbeddings([chunk])

      // Crear un registro en la BD con el texto y el embedding
      await DescriptionChunk.create({
        photoId,
        chunk,
        embedding: embeddings[0],
      })
    }
  }

  private splitIntoChunks(desc: string, numChunks: number): string[] {
    const sentences = desc.split(/(?<=[.!?])\s+/) // Dividir por oraciones que terminan en punto, exclamación o interrogación
    const totalSentences = sentences.length
    const chunkSize = Math.ceil(totalSentences / numChunks) // Calcular cuántas oraciones por fragmento

    const chunks: string[] = []
    for (let i = 0; i < totalSentences; i += chunkSize) {
      const chunk = sentences.slice(i, i + chunkSize).join(' ')
      chunks.push(chunk)
    }

    return chunks
  }

  public async processTag(
    tagName: string,
    group: string,
    tagMap: Map<string, any>,
    tagInstances: any[]
  ) {
    const modelsService = new ModelsService()
    const embedddingsService = new EmbeddingsService()

    const isStopword = (tagName: string) => STOPWORDS.includes(tagName.toLowerCase())

    if (!isStopword(tagName)) {
      const lemmatizedTagName = lemmatizer.stem(tagName.toLowerCase())

      let tag = tagMap.get(lemmatizedTagName)

      if (!tag) {
        let similarTagsResult: any
        try {
          similarTagsResult = await embedddingsService.findSimilarTagsToText(tagName, 0.89, 5)
        } catch (err) {
          console.log('Error in findSimilarTagsToText')
        }

        if (similarTagsResult?.length > 0) {
          for (const similarTag of similarTagsResult) {
            const existingTag = tagMap.get(similarTag.name)
            if (existingTag) {
              tagInstances.push(existingTag)
            }
          }
          console.log(
            `Using existing similar tags for ${tagName}: ${JSON.stringify(similarTagsResult.map((tag: any) => tag.name))}`
          )
          return
        }
      }

      if (!tag) {
        try {
          const stringForVector = `${tagName} (${group})` // 'black cat (animals)'
          const { embeddings } = await modelsService.getEmbeddings([stringForVector])
          tag = await Tag.create({ name: tagName, group, embedding: embeddings[0] })
          tagMap.set(lemmatizedTagName, tag)
          // console.log('Adding new tag: ', lemmatizedTagName)
        } catch (err) {
          if (err.code === '23505') {
            console.log(`Tag ${tagName} already exists, fetching existing one.`)
            tag = await Tag.query().where('name', tagName).first()
          } else {
            throw err
          }
        }
      }
      if (tag) tagInstances.push(tag)
    } else {
      console.log('Ignoring tag: ', tagName)
    }
  }

  private async compressPhotos(photos) {
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    let minQuality = 30
    let minSizeKb = 80

    for (const photo of photos) {
      const filePath = path.join(uploadPath, photo.name)
      const tempFilePath = path.join(uploadPath, `temp-${photo.name}`)

      try {
        await fs.access(filePath) // Verifica si el archivo existe

        let quality = 80 // Calidad inicial (ajustable)

        while (true) {
          // Redimensiona la imagen con un ancho fijo de 512px, manteniendo la proporción
          await sharp(filePath)
            .resize({ width: 512, fit: 'inside' })
            .jpeg({ quality, progressive: true }) // Comprime con calidad ajustable
            .toFile(tempFilePath)

          // Obtiene el tamaño del archivo resultante
          const stats = await fs.stat(tempFilePath)
          if (stats.size <= minSizeKb * 1024 || quality <= minQuality) break // Sale si cumple con el tamaño o si la calidad es muy baja

          quality -= 5 // Reduce la calidad y reintenta
        }

        // Reemplaza el archivo original con el comprimido
        await fs.rename(tempFilePath, filePath)
      } catch (error) {
        console.error(`Error procesando ${photo.name}:`, error)

        // Limpieza: elimina el archivo temporal si existe
        try {
          await fs.unlink(tempFilePath)
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            console.error(`Error eliminando archivo temporal ${tempFilePath}:`, unlinkError)
          }
        }
      }
    }
  }
}
