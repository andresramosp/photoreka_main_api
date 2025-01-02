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
import { SYSTEM_MESSAGE_ANALIZER, SYSTEM_MESSAGE_ANALIZER_2 } from '../utils/GPTMessages.js'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pluralize = require('pluralize')

const lemmatizer = {
  stem: (word: string) => pluralize.singular(word.toLowerCase()),
}

export default class AnalyzerService {
  /**
   * Asociar tags a una foto con soporte por lotes
   */
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
              detail: 'low',
            },
          })),
        ],
        'gpt-4o-mini'
      )

      batchPromises.push(batchPromise)

      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    const responses = await Promise.allSettled(batchPromises)

    const results: any[] = []
    const costs: any[] = []

    responses.forEach((response) => {
      if (response.status === 'fulfilled') {
        try {
          results.push(...response.value.result)
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

  public async addMetadata(metadata: { id: string; [key: string]: any }[]) {
    const modelsService = new ModelsService()

    // Fetch all tags once and preprocess them
    const existingTags = await Tag.all()
    const tagMap = new Map(
      existingTags.map((tag) => [lemmatizer.stem(tag.name.toLowerCase()), tag])
    )

    const isStopword = (tagName: string) => STOPWORDS.includes(tagName.toLowerCase())

    for (const data of metadata) {
      const { id, description, ...rest } = data
      const photo = await Photo.query().where('id', id).first()

      if (photo) {
        const updateData: Partial<Photo> = {}
        const tagInstances: any[] = []

        const processTag = async (tagName: string, group: string) => {
          if (!isStopword(tagName)) {
            const lemmatizedTagName = lemmatizer.stem(tagName.toLowerCase())
            let tag = tagMap.get(lemmatizedTagName)

            if (!tag) {
              tag = await Tag.create({ name: tagName, group })
              tagMap.set(lemmatizedTagName, tag)
              console.log('Adding new tag: ', lemmatizedTagName)
            }

            tagInstances.push(tag)
          } else {
            console.log('Ignoring tag: ', tagName)
          }
        }

        // Extract tags from description
        if (description) {
          const descTags = await modelsService.textToTags(description)
          for (const tagName of descTags) {
            await processTag(tagName, 'desc')
          }
        }

        // Process rest tags
        for (const key of Object.keys(rest)) {
          if (key.endsWith('_tags')) {
            const group = key.replace('_tags', '')
            const tags = rest[key] || []
            for (const tagName of tags) {
              await processTag(tagName, group)
            }
          }
        }

        // Update photo fields and metadata
        const fields = Array.from(Photo.$columnsDefinitions.keys()) as (keyof Photo)[]
        for (const key of fields) {
          if (rest[key]) {
            updateData[key] = rest[key] as any
            delete rest[key]
          }
        }

        photo.merge({ ...updateData, description, metadata: { ...photo.metadata, ...rest } })
        await photo.save()

        // Sync tags with the photo
        if (tagInstances.length > 0) {
          await photo.related('tags').sync(
            tagInstances.map((tag) => tag.id),
            true
          )
        }
      }
    }
  }
}
