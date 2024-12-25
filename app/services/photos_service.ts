import Photo from '#models/photo'

export default class PhotosService {
  /**
   * Asociar tags a una foto
   */
  public async getPhotosByIds(photoIds: string[]) {
    const photos = await Photo.query().whereIn('id', photoIds).preload('tags') // Si necesitas cargar las relaciones, como 'tags'
    return photos
  }

  public async addMetadata(metadata: { id: string; [key: string]: any }[]) {
    for (const data of metadata) {
      const { id, ...rest } = data

      const photo = await Photo.query().where('id', id).first()

      if (photo) {
        // Separate fields that match columns in Photo
        const fields = Array.from(Photo.$columnsDefinitions.keys()) as (keyof Photo)[]

        const updateData: Partial<Photo> = {}

        for (const key of fields) {
          if (rest[key]) {
            updateData[key] = rest[key] as any
            delete rest[key]
          }
        }

        // Update photo data
        photo.merge({ ...updateData, metadata: { ...photo.metadata, ...rest } })
        await photo.save()
      }
    }
  }
}
