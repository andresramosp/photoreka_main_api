import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary() // ID numérico incremental
      table.jsonb('descriptions')
      table.integer('analyzer_process_id').references('id').inTable('analyzer_processes')
      table.string('title')
      table.string('name')
      table.string('thumbnail_name')
      table.string('model')
      table.text('url')
      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
