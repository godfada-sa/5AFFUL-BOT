'use strict'

const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { watch } = require('../../lib/safful-reconnect-watchdog')
const marker = process.env.SAFFUL_E2E_OUTPUT
if (fs.existsSync(marker)) {
  process.stdout.write('replacement worker ready\n')
} else {
  fs.writeFileSync(marker, 'started', { flag: 'wx' })
  const socket = { ev: new EventEmitter() }
  watch(socket)
  socket.ev.emit('connection.update', { connection: 'open' })
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: {
    error: { output: { statusCode: 500 }, data: { tag: 'ack', attrs: { class: 'status' } } }
  } })
  // Model the panel symptom: the event loop stays alive with no usable socket.
  setInterval(() => {}, 1000)
}
