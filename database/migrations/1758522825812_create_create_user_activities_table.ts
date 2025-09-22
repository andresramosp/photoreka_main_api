import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'user_activities'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // Foreign key para el usuario
      table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE')

      // Tipo de actividad
      table.string('type', 50).notNullable()

      // Nivel de la actividad
      table.string('level', 20).defaultTo('info')

      // Acción realizada
      table.string('action', 255).notNullable()

      // Descripción opcional
      table.text('description').nullable()

      // Metadata adicional como JSON
      table.json('metadata').nullable()

      // Información de la request
      table.string('ip_address', 45).nullable()
      table.text('user_agent').nullable()
      table.string('endpoint', 500).nullable()
      table.integer('status_code').nullable()
      table.integer('response_time').nullable() // en milliseconds

      table.timestamp('created_at')
      table.timestamp('updated_at')

      // Índices para mejorar las consultas
      table.index(['user_id', 'created_at'])
      table.index(['type', 'created_at'])
      table.index(['level', 'created_at'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
