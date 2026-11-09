const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { watch } = require('../lib/safful-reconnect-watchdog')

test('stalled disconnect restarts only after the deadline; replacement open cancels it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exit = t.mock.method(process, 'exit', () => {})
  const first = { ev: new EventEmitter() }
  const next = { ev: new EventEmitter() }
  const close = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } }
  watch(first)
  first.ev.emit('connection.update', { connection: 'open' })
  first.ev.emit('connection.update', close)
  watch(next)
  next.ev.emit('connection.update', { connection: 'open' })
  first.ev.emit('connection.update', close)
  t.mock.timers.tick(30000)
  assert.equal(exit.mock.callCount(), 0)
  next.ev.emit('connection.update', close)
  t.mock.timers.tick(30000)
  assert.equal(exit.mock.calls[0].arguments[0], 1)
})

test('close before first open arms recovery, while logout cancels it', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exit = t.mock.method(process, 'exit', () => {})
  const socket = { ev: new EventEmitter() }
  watch(socket)
  const signal = (connection, code) => socket.ev.emit('connection.update', {
    connection, lastDisconnect: { error: { statusCode: code } }
  })
  signal('close', 401)
  signal('close', 502)
  t.mock.timers.tick(29999)
  signal('close', 401)
  t.mock.timers.tick(30000)
  assert.equal(exit.mock.callCount(), 0)
  signal('close', 428)
  t.mock.timers.tick(30000)
  assert.equal(exit.mock.callCount(), 1)
})
