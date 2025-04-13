import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.raw(`
      ALTER TABLE ${this.tableName}
      ADD COLUMN embedding VECTOR(512)
    `)

    this.schema.raw(`
      CREATE INDEX photos_embedding_idx ON ${this.tableName} USING ivfflat (embedding) WITH (lists = 100);
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX IF EXISTS photos_embedding_idx`)
    this.schema.raw(`ALTER TABLE ${this.tableName} DROP COLUMN IF EXISTS embedding`)
  }
}
