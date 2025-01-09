import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tags'

  async up() {
    this.schema.raw(`
      CREATE TABLE ${this.tableName} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        "group" VARCHAR(255),
        children JSONB,
        embedding VECTOR(384),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  async down() {
    this.schema.raw(`DROP TABLE ${this.tableName}`)
  }
}
