import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.raw(`
      ALTER TABLE ${this.tableName}
      ADD COLUMN color_array float8[]
    `)
  }

  async down() {
    // await this.schema.raw(`DROP INDEX IF EXISTS photos_color_array_idx`)
    this.schema.raw(`ALTER TABLE ${this.tableName} DROP COLUMN IF EXISTS color_array`)
  }
}
