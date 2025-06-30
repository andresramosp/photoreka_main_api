import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.raw(`
      ALTER TABLE ${this.tableName}
      ADD COLUMN color_histogram VECTOR(64),
      ADD COLUMN color_histogram_dominant VECTOR(64)
    `)

    this.schema.raw(`
      CREATE INDEX photos_color_histogram_idx ON ${this.tableName} USING ivfflat (color_histogram) WITH (lists = 100);
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX IF EXISTS photos_color_histogram_idx`)
    this.schema.raw(`ALTER TABLE ${this.tableName} DROP COLUMN IF EXISTS color_histogram`)
    this.schema.raw(`ALTER TABLE ${this.tableName} DROP COLUMN IF EXISTS color_histogram_dominant`)
  }
}
