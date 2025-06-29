import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.raw(`
      ALTER TABLE ${this.tableName}
      ADD COLUMN color_palette VECTOR(15)
    `)

    this.schema.raw(`
      CREATE INDEX photos_color_palette_idx ON ${this.tableName} USING ivfflat (color_palette) WITH (lists = 100);
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX IF EXISTS photos_color_palette_idx`)
    this.schema.raw(`ALTER TABLE ${this.tableName} DROP COLUMN IF EXISTS color_palette`)
  }
}
