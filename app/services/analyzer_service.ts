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
  SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY,
  SYSTEM_MESSAGE_ANALYZER_GPT_DESC,
  SYSTEM_MESSAGE_ANALYZER_MOLMO_STREET_PHOTO_PRETRAINED,
  SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED,
  SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
  SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
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

let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export default class AnalyzerService {
  public async *analyzeGPTAndMolmo(photosIds: string[]) {
    const photosService = new PhotosService()
    const modelsService = new ModelsService()

    let photos = await photosService.getPhotosByIds(photosIds)
    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    let photosToProcess: any[] = []
    let photosAlreadyProcessed: any[] = []

    // Revisar cada foto y separar las que ya tienen descripciones context y story
    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`)
      try {
        await fs.access(filePath)
        const resizedBuffer = await sharp(filePath).toBuffer()
        const base64Image = resizedBuffer.toString('base64')

        if (photo.processed?.context && photo.processed.story) {
          photosAlreadyProcessed.push({
            id: photo.id,
            base64: base64Image,
            context: photo.descriptions?.context,
            story: photo.descriptions.story,
          })
        } else {
          photosToProcess.push({
            id: photo.id,
            base64: base64Image,
          })
        }
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (photosToProcess.length === 0 && photosAlreadyProcessed.length === 0) {
      throw new Exception('No valid images found for the provided IDs')
    }

    const GPTResponses = []
    const maxImagesPerBatchGPT = 6

    // Llamada a GPT solo para las fotos sin descripciones
    for (let i = 0; i < photosToProcess.length; i += maxImagesPerBatchGPT) {
      const batch = photosToProcess.slice(i, i + maxImagesPerBatchGPT)
      const responseGPT = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_ANALYZER_GPT_CONTEXT_AND_STORY(batch),
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
      GPTResponses.push(...responseGPT.result)
      await sleep(750)
    }

    await Promise.all(
      GPTResponses.map(({ id, context, story }) =>
        photosService.updatePhoto(id, {
          descriptions: {
            context,
            story,
          },
          processed: {
            context: true,
            story: true,
          },
        })
      )
    )

    // Combinar fotos ya procesadas con las que se acaban de procesar
    const photosWithPretrained = photosToProcess
      .map((photo) => ({
        ...photo,
        context: GPTResponses.find((sd) => sd.id == photo.id)?.context,
        story: GPTResponses.find((sd) => sd.id == photo.id)?.story,
      }))
      .concat(photosAlreadyProcessed)

    // FASE MOLMO

    const MolmoResponses = []
    const batchPromisesMolmo = []
    let maxImagesPerBatchMolmo = photosWithPretrained.length

    const photosForMolmo = photosWithPretrained.filter((photo) => !photo.processed?.topology)

    for (let i = 0; i < photosForMolmo.length; i += maxImagesPerBatchMolmo) {
      const batch = photosForMolmo.slice(i, i + maxImagesPerBatchMolmo)

      let { result: responseMolmo } = await modelsService.getMolmoResponse(
        batch.map((photo) => ({ id: photo.id, base64: photo.base64 })),
        [],
        [
          ...photosForMolmo.map((photo) => ({
            id: photo.id,
            prompts: [
              {
                id: 'topology',
                text: SYSTEM_MESSAGE_ANALYZER_MOLMO_TOPOLOGIC_AREAS_PRETRAINED(photo.context),
              },
            ],
          })),
        ]
      )

      MolmoResponses.push(...responseMolmo)
    }

    await Promise.all(
      MolmoResponses.map(({ id, descriptions: molmo_descriptions }) =>
        photosService.updatePhoto(id, {
          descriptions: {
            topology: molmo_descriptions.find((d) => d.id_prompt == 'topology').description,
          },
          processed: { topology: true },
        })
      )
    )

    photos = await photosService.getPhotosByIds(photosIds)

    const photosWithDescs = photos.map((photo) => ({
      id: photo.id,
      context: photo.descriptions?.context,
      story: photo.descriptions?.story,
      topology: photo.descriptions?.topology,
      artistic: photo.descriptions?.artistic,
    }))

    let { photosWithTags, costs } = await this.addTagsFromDescs(photosWithDescs, false)

    await this.processDescAndTags(photosWithTags)

    await Promise.all(
      photosWithTags.map(({ id }) =>
        photosService.updatePhoto(id, {
          processed: { tags: true },
        })
      )
    )
    yield { type: 'analysisComplete', data: { costs } }
  }

  private async cleanPhotosDescs(photosWithDescs, batchSize = 5, delayMs = 500) {
    const modelsService = new ModelsService()

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const results = { cleanContextAndStory: [], cleanTopology: [] }

    for (let i = 0; i < photosWithDescs.length; i += batchSize) {
      const batch = photosWithDescs.slice(i, i + batchSize)

      const [cleanContextAndStoryBatch, cleanTopologyBatch] = await Promise.all([
        modelsService.cleanDescriptions(
          batch.map((photo) => `1. Context: ${photo.context} | 2. Story: ${photo.story}`),
          0.9
        ),
        modelsService.cleanDescriptions(
          batch.map((photo) => `${photo.topology}`),
          1
        ),
      ])

      results.cleanContextAndStory.push(...cleanContextAndStoryBatch)
      results.cleanTopology.push(...cleanTopologyBatch)

      if (i + batchSize < photosWithDescs.length) {
        await delay(delayMs)
      }
    }

    return results
  }

  private async addTagsFromDescs(photosWithDescs: any[]): Promise<any[]> {
    const modelsService = new ModelsService()
    const nlpService = new NLPService()
    let costs: number[] = []
    const delayMs = 500

    // 1. Limpiar descripciones para todas las fotos de golpe, en paralelo
    const { cleanContextAndStory, cleanTopology } = await this.cleanPhotosDescs(photosWithDescs)

    const tasks = photosWithDescs.map(async (photo, index) => {
      const tagsDict: { [key: string]: string[] } = {}

      const cleanedContextAndStoryForPhoto = cleanContextAndStory[index]
      const cleanedTopologyForPhoto = cleanTopology[index]

      // 2. Extraer tags en paralelo
      const [contextStoryResponse, topologyResponse] = await Promise.all([
        modelsService.getGPTResponse(
          SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_CONTEXT_STORY,
          JSON.stringify({ description: cleanedContextAndStoryForPhoto }),
          'gpt-4o-mini'
        ),
        modelsService.getGPTResponse(
          SYSTEM_MESSAGE_TAGS_TEXT_EXTRACTION_FROM_TOPOLOGY,
          JSON.stringify({ description: cleanedTopologyForPhoto }),
          'gpt-4o-mini'
        ),
      ])

      const { tags: contextStoryTags } = contextStoryResponse.result
      const { tags: topologyTags } = topologyResponse.result

      costs.push(contextStoryResponse.cost, topologyResponse.cost)

      let completeTagList = [...contextStoryTags, ...topologyTags]

      // Verificar si existe el grupo "person"
      const hasPerson = completeTagList.some((tag) => tag.split('|')[1].trim() === 'person')
      if (!hasPerson) {
        completeTagList.push('no people | misc')
      }

      // 3. Sacar sustantivos de tags, solo de ciertos grupos
      let sustantivesFromTag: string[] = []
      for (let tag of completeTagList) {
        let [tagName, group] = tag.split('|').map((item) => item.trim())
        if (['person', 'animals'].includes(group)) {
          let sustantives = nlpService.getSustantives(tagName)
          if (sustantives?.length) sustantivesFromTag.push(...sustantives)
        }
      }

      let tagsForDict: string[] = []

      // 5. Sacar grupos de tags (desde respuesta de GPT o con BERT)
      // let sustantiveGroupsResult = await modelsService.generateGroupsForTags([
      //   ...sustantivesFromTag,
      // ])
      // tagsForDict = [...completeTagList, ...sustantiveGroupsResult]
      tagsForDict = [...completeTagList, ...sustantivesFromTag]

      // 6. Procesar tags | grupos
      tagsForDict.forEach((tagStr: string) => {
        const [tag, group = 'misc'] = tagStr.split('|').map((item) => item.trim())
        if (!tagsDict[group]) {
          tagsDict[group] = []
        }
        tagsDict[group].push(tag)
      })

      Object.assign(photo, { generatedTags: tagsDict })
      await sleep(index * delayMs)
    })

    await Promise.all(tasks)
    return { photosWithTags: photosWithDescs, costs }
  }

  public async processDescAndTags(dictionary: { id: string; [key: string]: any }[]) {
    const photosService = new PhotosService()

    const existingTags = await Tag.all()
    const tagMap = new Map(
      existingTags.map((tag) => [lemmatizer.stem(tag.name.toLowerCase()), tag])
    )

    await Promise.all(
      dictionary.map(async (dictData) => {
        const { id, generatedTags } = dictData

        const photo = await Photo.query().where('id', id).first()

        await sleep(500)

        if (photo) {
          const updateData: any = {}
          const tagInstances: any[] = []

          await Promise.all([
            await this.createDescChunks(photo),
            ...Object.keys(generatedTags).map(async (group) => {
              let tags = generatedTags[group] || []
              for (const tagName of tags) {
                await this.processTag(tagName, group, tagMap, tagInstances)
                await sleep(1000)
              }
            }),
          ])

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
  public async createDescChunks(photo: Photo) {
    const modelsService = new ModelsService()

    if (!photo.descriptions || typeof photo.descriptions !== 'object') {
      throw new Error('No descriptions found for this photo')
    }

    // Función para crear un retardo
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const tasks: Promise<void>[] = []

    for (const category of Object.keys(photo.descriptions)) {
      const description = photo.descriptions[category]
      if (!description) continue

      let descriptionChunks
      if (category === 'topology') {
        descriptionChunks = description.split('|').filter((ch) => ch.length > 0)
      } else {
        descriptionChunks = this.splitIntoChunks(description, description.length / 300)
      }

      await DescriptionChunk.query().where('photoId', photo.id).where('category', category).delete()

      const { embeddings } = await modelsService.getEmbeddings(descriptionChunks)
      await Promise.all(
        descriptionChunks.map((chunk, index) =>
          DescriptionChunk.create({
            photoId: photo.id,
            chunk,
            category,
            embedding: embeddings[index],
          })
        )
      )
    }

    await Promise.all(tasks)
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
          // const stringForVector = `${tagName} (${group})` // 'black cat (animals)'
          const { embeddings } = await modelsService.getEmbeddings([tagName])
          tag = await Tag.create({ name: tagName, group, embedding: embeddings[0] })
          tagMap.set(lemmatizedTagName, tag)
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
    const maxImagesPerBatchGPT = 4

    for (let i = 0; i < photosToProcess.length; i += maxImagesPerBatchGPT) {
      const batch = photosToProcess.slice(i, i + maxImagesPerBatchGPT)

      const responseGPT = await modelsService.getGPTResponse(
        SYSTEM_MESSAGE_ANALYZER_GPT_DESC(batch),
        batch.map(({ base64 }) => ({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64}`,
            detail: 'low',
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
