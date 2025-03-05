import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tags_photos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.integer('photo_id').references('id').inTable('photos')
      table.integer('tag_id').references('id').inTable('tags')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
