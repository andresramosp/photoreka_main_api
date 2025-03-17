import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'descriptions_chunks'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id SERIAL PRIMARY KEY,
        photo_id INTEGER NOT NULL,
        chunk TEXT,
        category VARCHAR(128),
        area VARCHAR(32),
        embedding VECTOR(768),
        CONSTRAINT fk_photo FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
      )
    `)

    this.schema.raw(`
      CREATE INDEX descriptions_chunks_idx ON ${this.tableName} USING ivfflat (embedding) WITH (lists = 100);
    `)
  }

  async down() {
    this.schema.raw(`DROP INDEX IF EXISTS descriptions_chunks_idx`)
    this.schema.raw(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
