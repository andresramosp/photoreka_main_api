import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tags_photos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table
        .integer('photo_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('photos')
        .onDelete('CASCADE')
      table
        .integer('tag_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('tags')
        .onDelete('CASCADE')
      table.string('category')

      table.primary(['photo_id', 'tag_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
