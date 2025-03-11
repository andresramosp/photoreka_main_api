import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateAnalyzerProcesses extends BaseSchema {
  protected tableName = 'analyzer_processes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('package_id', 255)
      table.jsonb('tasks').nullable() // Se almacena como JSONB
      table
        .enum('current_stage', [
          'init',
          'vision_tasks',
          'tags_tasks',
          'embeddings_tags',
          'chunks_tasks',
          'embeddings_chunks',
          'finished',
        ])
        .nullable()
      table
        .integer('user_id')
        .nullable()
        .unsigned()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL')
      table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
