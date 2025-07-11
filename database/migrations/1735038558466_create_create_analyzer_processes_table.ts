import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateAnalyzerProcesses extends BaseSchema {
  protected tableName = 'analyzer_processes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('package_id', 255)
      table.jsonb('process_sheet').nullable() // Se almacena como JSONB
      table.string('mode', 255).nullable()
      table.string('current_stage', 255).nullable()
      table.boolean('is_fast_mode')
      table.boolean('is_preprocess')
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
