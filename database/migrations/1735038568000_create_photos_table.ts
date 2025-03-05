import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'photos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary() // ID numérico incremental
      table.text('description_short')
      table.text('description_generic')
      table.text('description_genre')
      table.text('description_topologic')
      table.string('title')
      table.string('name')
      table.string('model')
      table.text('url')
      table.boolean('processed').defaultTo(false)
      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
