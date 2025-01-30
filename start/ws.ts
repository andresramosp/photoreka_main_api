import Ws from '#services/ws'
import app from '@adonisjs/core/services/app'

app.ready(() => {
  Ws.boot()
  const io = Ws.io
  io?.on('connection', (socket) => {
    console.log(socket.id)
  })
})
