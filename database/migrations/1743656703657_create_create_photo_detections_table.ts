import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'detections_photos'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table
        .integer('photo_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('photos')
        .onDelete('CASCADE')

      // Coordenadas rectangulares
      table.float('x1').notNullable()
      table.float('y1').notNullable()
      table.float('x2').notNullable()
      table.float('y2').notNullable()

      // Categoría del objeto detectado (e.g., "person", "dog", etc.)
      table.string('category').notNullable()

      // Opcional: score/confianza
      table.float('score')

      table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
