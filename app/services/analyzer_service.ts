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
import { SYSTEM_MESSAGE_ANALIZER_2 } from '../utils/ModelsMessages.js'
import { createRequire } from 'module'
import EmbeddingsService from './embeddings_service.js'
import DescriptionChunk from '#models/descriptionChunk'
import MeasureExecutionTime from '../decorators/measureExecutionTime.js'
import withCost from '../decorators/withCost.js'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const lemmatizer = {
  stem: (word: string) => pluralize.singular(word.toLowerCase()),
}

export default class AnalyzerService {
  /**
   * Asociar tags a una foto con soporte por lotes
   */
  @withCost
  // @MeasureExecutionTime
  public async analyze(photosIds: string[], maxImagesPerBatch = 3) {
    const photosService = new PhotosService()
    const modelsService = new ModelsService()

    const photos = await photosService.getPhotosByIds(photosIds)

    const uploadPath = path.join(process.cwd(), 'public/uploads/photos')

    const validImages = []
    for (const photo of photos) {
      const filePath = path.join(uploadPath, `${photo.name}`) // Ajusta la extensión según corresponda

      try {
        // Verificar si el archivo existe
        await fs.access(filePath)

        // Procesar la imagen con sharp
        const resizedBuffer = await sharp(filePath)
          .resize({ width: 1024, fit: 'inside' })
          .toBuffer()

        validImages.push({
          id: photo.id, // Usar el ID proporcionado
          base64: resizedBuffer.toString('base64'),
        })
      } catch (error) {
        console.warn(`No se pudo procesar la imagen con ID: ${photo.id}`, error)
      }
    }

    if (validImages.length === 0) {
      throw new Exception('No valid images found for the provided IDs')
    }

    // Procesar en lotes con Promise.allSettled para manejar errores individuales
    const batchPromises = []
    for (let i = 0; i < validImages.length; i += maxImagesPerBatch) {
      const batch = validImages.slice(i, i + maxImagesPerBatch)

      const batchPromise = modelsService.getGPTResponse(
        SYSTEM_MESSAGE_ANALIZER_2(batch),
        [
          ...batch.map(({ base64 }) => ({
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64}`,
              detail: 'high',
            },
          })),
        ],
        'gpt-4o-mini'
      )

      batchPromises.push(batchPromise)

      await new Promise((resolve) => setTimeout(resolve, 750))
    }

    const responses = await Promise.allSettled(batchPromises)

    const results: any[] = []
    const costs: any[] = []

    responses.forEach((response) => {
      if (response.status === 'fulfilled') {
        try {
          results.push(response.value.result)
          costs.push(response.value.cost)
        } catch (err) {
          console.log(err)
        }
      } else {
        console.warn('Batch processing failed:', response.reason)
      }
    })

    // Agregar metadatos
    await this.addMetadata(results)

    // Retornar el resultado combinado
    return {
      results,
      cost: costs,
    }
  }

  // public findTagsWithSimilarWords(tag: string, tagList: string[]) {
  //   const STOPWORDS = ['at', 'in', 'on', 'the', 'and', 'or', 'but', 'a', 'an', 'of', 'for', 'to']

  //   // Helper function to lemmatize and filter words
  //   function lemmatizeAndFilter(text: string) {
  //     const words = text
  //       .toLowerCase()
  //       .split(/\W+/) // Split on non-word characters
  //       .filter((word) => word && !STOPWORDS.includes(word)) // Remove stopwords

  //     return words.map((word) => lemmatizer.stem(word))
  //   }

  //   // Lemmatize and filter the input tag
  //   const lemmatizedTagWords = lemmatizeAndFilter(tag)

  //   // Find tags with at least 50% overlapping lemmatized words in both directions
  //   return tagList.filter((candidateTag) => {
  //     const candidateWords = lemmatizeAndFilter(candidateTag)
  //     const matchCount = candidateWords.filter((word) => lemmatizedTagWords.includes(word)).length
  //     const forwardMatch = matchCount / lemmatizedTagWords.length >= 0.5
  //     const backwardMatch = matchCount / candidateWords.length >= 0.5
  //     return forwardMatch && backwardMatch
  //   })
  // }

  @MeasureExecutionTime
  public async addMetadata(metadata: { id: string; [key: string]: any }[]) {
    const existingTags = await Tag.all()
    const tagMap = new Map(
      existingTags.map((tag) => [lemmatizer.stem(tag.name.toLowerCase()), tag])
    )

    // Process all metadata entries in parallel
    await Promise.all(
      metadata.map(async (data) => {
        const { id, description, ...rest } = data
        const photo = await Photo.query().where('id', id).first()

        if (photo) {
          const updateData: any = {}
          const tagInstances: any[] = []
          await Promise.all([
            await this.processDesc(description, photo.id),
            ...Object.keys(rest)
              .filter((key) => key.endsWith('_tags'))
              .map(async (key) => {
                const group = key.replace('_tags', '')
                const tags = rest[key] || []
                await Promise.all(
                  tags.map((tagName: string) =>
                    this.processTag(tagName, group, tagMap, tagInstances)
                  )
                )
              }),
          ])

          const fields = Array.from(Photo.$columnsDefinitions.keys())
          fields.forEach((key) => {
            if (rest[key]) {
              updateData[key] = rest[key]
              delete rest[key]
            }
          })

          photo.merge({ ...updateData, description, metadata: { ...photo.metadata, ...rest } })
          await photo.save()

          if (tagInstances.length > 0) {
            // Eliminar duplicados basados en el campo "name"
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
  public async processDesc(desc: string, photoId: string) {
    const modelsService = new ModelsService()

    // Dividir el texto en 5 fragmentos de tamaño similar, terminando en puntos
    const splitChunks = this.splitIntoChunks(desc, 5)

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
          console.log('Error in getSemanticSynonymTags')
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
          const { embeddings } = await modelsService.getEmbeddings([tagName])
          tag = await Tag.create({ name: tagName, group, embedding: embeddings[0] })
          tagMap.set(lemmatizedTagName, tag)
          console.log('Adding new tag: ', lemmatizedTagName)
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
}
