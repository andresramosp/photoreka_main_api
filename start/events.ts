import emitter from '@adonisjs/core/services/emitter'

emitter.on('db:query', (query) => {
  console.log(query.sql, query.bindings)
})
