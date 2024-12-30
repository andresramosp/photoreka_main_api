import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import env from '#start/env'
import axios from 'axios'
import PhotosService from './photos_service.js'
import Photo from '#models/photo'
import { Exception } from '@adonisjs/core/exceptions'
import ModelsService from './models_service.js'
import Tag from '#models/tag'
import { SYSTEM_MESSAGE_ANALIZER } from '../utils/GPTMessages.js'

const COST_PER_1M_TOKENS_USD = 2.5
const USD_TO_EUR = 0.92
const COST_PER_TOKEN_EUR = (COST_PER_1M_TOKENS_USD / 1_000_000) * USD_TO_EUR

export default class AnalyzerService {
  /**
   * Asociar tags a una foto con soporte por lotes
   */
  public async analyze(photosIds: string[], maxImagesPerBatch = 10) {
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

    const results = []
    const costs = []

    // Procesar en lotes
    for (let i = 0; i < validImages.length; i += maxImagesPerBatch) {
      const batch = validImages.slice(i, i + maxImagesPerBatch)

      const { result, cost } = await modelsService.getGPTResponse('', [
        {
          type: 'text',
          text: SYSTEM_MESSAGE_ANALIZER(batch),
        },
        ...batch.map(({ base64 }) => ({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${base64}`,
            detail: 'low',
          },
        })),
      ])

      results.push(...result)
      costs.push(cost)
    }

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
    const tagMap = new Map(existingTags.map((tag) => [tag.name.toLowerCase(), tag]))

    // Prepare a unified list of all tags to process (rest and misc)
    const allTagsToProcess = []
    for (const data of metadata) {
      const { description, ...rest } = data
      if (description) {
        const descriptionTags = await modelsService.textToTags(description)
        allTagsToProcess.push(...descriptionTags)
      }
      Object.keys(rest)
        .filter((key) => key.endsWith('_tags'))
        .forEach((key) => allTagsToProcess.push(...(rest[key] || [])))
    }

    for (const data of metadata) {
      const { id, description, ...rest } = data
      const photo = await Photo.query().where('id', id).first()

      if (photo) {
        const updateData: Partial<Photo> = {}
        const tagInstances: any[] = []

        const processTag = async (tagName: string, group: string) => {
          let tag = tagMap.get(tagName.toLowerCase())
          if (!tag) {
            tag = await Tag.create({ name: tagName, group })
            tagMap.set(tagName.toLowerCase(), tag)
            console.log('Adding new tag: ', tagName.toLowerCase())
          }
          tagInstances.push(tag)
        }

        // Process misc tags
        if (description) {
          const miscTags = await modelsService.textToTags(description)
          for (const tagName of miscTags) {
            await processTag(tagName, 'misc')
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
