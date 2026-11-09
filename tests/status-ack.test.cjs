'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { watch } = require('../lib/safful-reconnect-watchdog')
const { buildAckStanza } = require('@whiskeysockets/baileys/lib/Utils/stanza-ack.js')

test('pinned Baileys socket writes a decodable status ACK on its transport', async t => {
  const { default: makeSocket, initAuthCreds, decodeBinaryNode, NOISE_WA_HEADER } = require('@whiskeysockets/baileys')
  const { WebSocketClient } = require('@whiskeysockets/baileys/lib/Socket/Client/websocket.js')
  const frames = []
  t.mock.method(WebSocketClient.prototype, 'connect', function () {
    this.socket = { readyState: 1, send(bytes, done) { frames.push(bytes); done() } }
  })
  t.mock.method(WebSocketClient.prototype, 'close', async function () { this.socket = null })
  const creds = initAuthCreds()
  creds.me = { id: '1000@s.whatsapp.net' }
  const socket = makeSocket({ auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger: require('pino')({ level: 'silent' }) })
  t.after(() => socket.end())
  watch(socket)
  socket.ws.emit('CB:status', { tag: 'status', attrs: { id: 'wire-test', from: 'status@broadcast', type: 'text' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(frames.length, 1)
  const packet = await decodeBinaryNode(frames[0].subarray(NOISE_WA_HEADER.length + 3))
  assert.equal(packet.tag, 'ack')
  assert.deepEqual({ ...packet.attrs }, { class: 'status', to: 'status@broadcast', id: 'wire-test', type: 'text' })
})

test('live and redelivered top-level statuses get one protocol ACK on each socket', async () => {
  for (const offline of [false, true]) {
    const sent = []
    const socket = {
      ev: new EventEmitter(), ws: new EventEmitter(),
      sendMessageAck: async node => sent.push(buildAckStanza(node))
    }
    watch(socket)
    watch(socket)
    const attrs = { id: 'test', from: 'status@broadcast', type: 'media', participant: 'test-user', offline: String(offline) }
    socket.ws.emit('CB:status', { tag: 'status', attrs })
    socket.ws.emit('CB:status', { tag: 'status', attrs: {} })
    socket.ws.emit('CB:message', { tag: 'message', attrs })
    assert.deepEqual(sent, [{ tag: 'ack', attrs: {
      id: 'test', to: 'status@broadcast', class: 'status', type: 'media', participant: 'test-user'
    } }])
  }
})

test('a native status handler is retained without sending duplicate ACKs', () => {
  const socket = { ev: new EventEmitter(), ws: new EventEmitter(), sendMessageAck() {} }
  const native = () => {}
  socket.ws.on('CB:status', native)
  watch(socket)
  assert.deepEqual(socket.ws.listeners('CB:status'), [native])
})
