'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const baileys = require('@whiskeysockets/baileys')
const root = path.join(__dirname, '..')
const sudo = '233240000001@s.whatsapp.net'

function setup(t, previous) {
  const dir = previous || fs.mkdtempSync(path.join(os.tmpdir(), 'safful-status-'))
  if (!previous) t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
  const registry = [], modules = new Map(), state = { downloads: 0, fail: false, bytes: 10 }
  function load(relative) {
    const filename = path.resolve(root, relative)
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, realRequire = createRequire(filename)
    const requireMock = name => {
      if (/lib\/plugins$/.test(name)) return { commands: registry, cmd: (options, fn) => {
        const command = { ...options, fn }; registry.push(command); return command
      } }
      if (name === '@whiskeysockets/baileys') return { ...baileys, downloadContentFromMessage: async media => {
        state.downloads++
        if (state.wait) await state.wait
        if (state.fail || media.directPath === '/expired') throw Object.assign(Error('expired'), { status: 410 })
        return (async function* () { yield Buffer.alloc(state.bytes, 65) })()
      } }
      if (name.endsWith('safful-identities')) return {
        ...require('../lib/safful-identities'),
        ownerJids: () => [sudo, '233240000002@s.whatsapp.net'],
        isOperator: async m => Boolean(m.fromMe),
      }
      if (name.startsWith('.')) return load(path.relative(root, realRequire.resolve(name)))
      return realRequire(name)
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, require: requireMock, Buffer, structuredClone,
      __filename: filename, __dirname: path.join(dir, 'lib'),
      process: { env: {}, stderr: { write() {} } }, global: {}, console,
      setInterval: () => ({ unref() {} }), setImmediate, setTimeout, clearTimeout
    }, { filename })
    modules.set(filename, module.exports)
    return module.exports
  }
  const sent = [], replies = []
  const socket = { ev: new EventEmitter(), ws: new EventEmitter(), user: { id: sudo, lid: '900001@lid' },
    sendMessage: async (jid, payload) => { if (state.sendFail) throw Error('offline'); sent.push({ jid, payload }) } }
  const engine = load('lib/safful-status-save.js')
  engine.attach(socket)
  socket.ev.emit('contacts.upsert', [{ id: '900003@lid', name: 'Ama Mensah', notify: 'Profile name' }])
  load('plugins/savestatus.js')
  const message = { fromMe: true, bot: socket, chat: '900003@lid', reply: async text => replies.push(text) }
  const run = (name, text, fromMe = true) => registry.find(c => c.pattern === name).fn({ ...message, fromMe }, text, { Void: socket })
  const receive = async raw => { socket.ev.emit('messages.upsert', { messages: [raw] }); await engine.idle() }
  const revoke = async key => { socket.ev.emit('messages.update', [{ key, update: { message: null, messageStubType: 1 } }]); await engine.idle() }
  return { load, engine, run, receive, revoke, state, dir, sent, socket, message, replies, registry }
}
function status(id, kind = 'image') {
  return { key: { id, remoteJid: 'status@broadcast', participant: '900003@lid' }, message:
    kind === 'text' ? { conversation: 'Good morning' } :
      { [kind + 'Message']: { directPath: '/valid', caption: 'Campus', mimetype: 'test/type', ptt: true } } }
}

test('E2E: savestatus aliases are unique, owner-only and deliver named media to sudo', async t => {
  const h = setup(t)
  h.load('plugins/save.js')
  assert.equal(h.registry.filter(c => c.pattern === 'savestatus' || c.alias?.includes('savestatus')).length, 1)
  await h.run('savestatus', 'on', false)
  assert.equal(h.engine.getEnabled(), false)
  await h.run('savestatus', 'on')
  for (const kind of ['image', 'video', 'audio', 'text', 'sticker']) await h.receive(status(kind, kind))
  assert.ok(h.sent.every(s => s.jid === sudo))
  assert.match(h.sent[0].payload.caption, /Ama Mensah.*\n\nCampus/)
  assert.match(h.sent.find(s => s.payload.text?.includes('Good morning')).payload.text, /Ama Mensah/)
  assert.ok(h.sent.some(s => s.payload.audio))
  const count = h.sent.length
  await h.receive(status('image'))
  await h.receive({ ...status('own'), key: { ...status('own').key, fromMe: true } })
  await h.run('savestatus', 'off')
  await h.receive(status('disabled'))
  assert.equal(h.sent.length, count)
  assert.equal(fs.existsSync(path.join(h.dir, '.safful-data', 'deleted-status')), false)
})

test('E2E: savedelstat captures before deletion, survives restart, and deduplicates revokes', async t => {
  const h = setup(t)
  await h.run('savedelstat', 'on')
  const raw = status('deleted')
  await h.receive(raw)
  assert.equal(h.sent.length, 0)
  assert.equal(h.engine.cacheStats().items, 1)
  const restarted = setup(t, h.dir)
  await restarted.revoke(raw.key)
  assert.equal(restarted.sent[0].jid, sudo)
  assert.match(restarted.sent[0].payload.caption, /Deleted status from Ama Mensah/)
  assert.equal(restarted.sent[0].payload.image.length, 10)
  await restarted.revoke(raw.key)
  assert.equal(restarted.sent.length, 1)
  assert.equal(restarted.engine.cacheStats().items, 0)
  await restarted.revoke(status('never-received').key)
  assert.equal(restarted.sent.length, 1)
})

test('deleted statuses use saved names across PN/LID aliases and recheck renames at deletion', async t => {
  const h = setup(t), pn = '233240000010@s.whatsapp.net', lid = '900010@lid'
  assert.ok(h.registry.find(c => c.pattern === 'savedelstat').alias.includes('savedelstatus'))
  await h.run('savedelstat', 'on')
  const raw = status('saved-name')
  raw.key.participant = lid
  raw.key.participantAlt = pn
  raw.pushName = 'Public profile'
  h.socket.ev.emit('contacts.upsert', [{ id: lid, notify: 'Public profile', verifiedName: 'Business name' }])
  h.socket.store = { contacts: new Map([[pn, { name: 'My saved friend' }]]) }
  h.socket.getName = async () => { throw Error('Do not use ambiguous profile-name fallback') }
  await h.receive(raw)
  const cache = path.join(h.dir, '.safful-data', 'deleted-status')
  const record = JSON.parse(fs.readFileSync(path.join(cache, fs.readdirSync(cache).find(f => f.endsWith('.json')))))
  assert.equal(record.name, 'My saved friend')
  assert.equal(record.savedName, true)
  h.socket.store.contacts.set(pn, { name: 'Renamed friend' })
  await h.revoke(raw.key)
  assert.match(h.sent[0].payload.caption, /Deleted status from Renamed friend/)
  assert.doesNotMatch(h.sent[0].payload.caption, /Public profile|Business name/)
})

test('status saved names resolve through stored identity mappings in either direction', async t => {
  const h = setup(t), pn = '233240000010@s.whatsapp.net', lid = '900010@lid'
  await h.run('savestatus', 'on')
  h.socket.signalRepository = { lidMapping: {
    getPNForLID: async id => id === lid ? pn : '',
    getLIDForPN: async id => id === pn ? lid : '',
  } }
  for (const [i, sender, stored] of [[0, lid, pn], [1, pn, lid]]) {
    h.socket.contacts = { [stored]: { name: 'Saved ' + i, notify: 'Profile' } }
    const raw = status('mapped-' + i)
    raw.key.participant = sender
    raw.pushName = 'Profile'
    await h.receive(raw)
    assert.match(h.sent[i].payload.caption, new RegExp('Status from Saved ' + i))
  }
})

test('old deleted-status cache never reuses a profile name and late contact sync supplies the saved name', async t => {
  const h = setup(t), pn = '233240000010@s.whatsapp.net'
  await h.run('savedelstat', 'on')
  const raw = status('old-cache')
  raw.key.participant = pn
  raw.pushName = 'Public profile'
  await h.receive(raw)
  const dir = path.join(h.dir, '.safful-data', 'deleted-status')
  const file = path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.json')))
  const record = JSON.parse(fs.readFileSync(file))
  record.name = 'Old cached profile'
  delete record.savedName
  fs.writeFileSync(file, JSON.stringify(record))
  const restarted = setup(t, h.dir)
  await restarted.revoke(raw.key)
  assert.match(restarted.sent[0].payload.caption, /Deleted status from 233240000010/)
  assert.doesNotMatch(restarted.sent[0].payload.caption, /profile/i)
  raw.key.id = 'late-sync'
  await restarted.receive(raw)
  restarted.socket.ev.emit('contacts.upsert', [{ id: pn, name: 'Late synced name', notify: 'Profile' }])
  await restarted.revoke(raw.key)
  assert.match(restarted.sent[1].payload.caption, /Deleted status from Late synced name/)
})

test('savedelstat obeys 64 MB cap, ignores oversized status, and off clears files', async t => {
  const h = setup(t)
  await h.run('savedelstat', 'on')
  h.state.bytes = 16 * 1024 * 1024
  for (let i = 0; i < 5; i++) await h.receive(status('big-' + i))
  assert.ok(h.engine.cacheStats().bytes <= 64 * 1024 * 1024)
  assert.equal(h.engine.cacheStats().items, 3) // metadata also counts toward the cap
  await h.revoke(status('big-0').key)
  assert.equal(h.sent.length, 0)
  h.state.bytes++
  await h.receive(status('too-big'))
  assert.equal(h.engine.cacheStats().items, 3)
  await h.run('savedelstat', 'off')
  assert.equal(h.engine.cacheStats().items, 0)
  assert.equal(fs.readdirSync(path.join(h.dir, '.safful-data', 'deleted-status')).length, 0)
})

test('deleted status send failure retains cache for retry; an expired entry is discarded on restart', async t => {
  const h = setup(t)
  await h.run('savedelstat', 'on')
  await h.receive(status('retry'))
  h.state.sendFail = true
  await h.revoke(status('retry').key)
  assert.equal(h.engine.cacheStats().items, 1)
  h.state.sendFail = false
  await h.revoke(status('retry').key)
  assert.equal(h.sent.length, 1)
  await h.receive(status('old'))
  const dir = path.join(h.dir, '.safful-data', 'deleted-status')
  const name = fs.readdirSync(dir).find(f => f.endsWith('.json'))
  const record = JSON.parse(fs.readFileSync(path.join(dir, name)))
  record.at = Date.now() - 25 * 60 * 60 * 1000
  fs.writeFileSync(path.join(dir, name), JSON.stringify(record))
  assert.equal(setup(t, h.dir).engine.cacheStats().items, 0)
})

test('E2E: kk handles raw and stored view-once quotes, PN/LID keys and expired URLs', async t => {
  const h = setup(t), kk = h.load('plugins/kk.js')
  for (const type of ['imageMessage', 'videoMessage', 'audioMessage', 'ptvMessage']) {
    const key = { remoteJid: '900003@lid', id: type, isViewOnce: true }
    const original = { key, message: { viewOnceMessageV2Extension: { message: { [type]: {
      directPath: '/expired', mediaKey: Buffer.alloc(32), ptt: true, caption: 'view once'
    } } } } }
    h.socket.updateMediaMessage = async raw => {
      assert.equal(raw.key.id, type)
      return { ...raw, message: { [type]: { directPath: '/fresh', ptt: true, caption: 'view once' } } }
    }
    await kk.unwrap({ ...h.message, quoted: { key, message: { conversation: 'stripped' } } }, '', {
      Void: h.socket, store: { loadMessage: async (chat, id) => {
        assert.equal(chat, '900003@lid'); assert.equal(id, type); return original
      } }
    })
  }
  assert.equal(h.sent.length, 4)
  assert.ok(h.sent.every(s => s.jid === sudo))
  assert.equal(h.sent[2].payload.ptt, true)
  assert.ok(h.sent[3].payload.video)
  await kk.unwrap({ ...h.message, message: { extendedTextMessage: { contextInfo: {
    stanzaId: 'raw', quotedMessage: { viewOnceMessage: { message: { imageMessage: { directPath: '/valid', mediaKey: Buffer.alloc(32) } } } }
  } } } }, '')
  assert.equal(h.sent.length, 5)
  await kk.unwrap({ ...h.message, quoted: { message: { imageMessage: { directPath: '/normal' } } } }, '')
  assert.equal(h.sent.length, 6)
  assert.equal(h.sent[5].jid, sudo)
  assert.ok(h.sent[5].payload.text)
  assert.equal(h.replies.length, 0, 'kk never posts errors in the originating chat')
})

test('kk replaces duplicate legacy registrations and preserves its existing aliases', async t => {
  const h = setup(t)
  h.registry.push({ pattern: 'kk', fn: () => { throw Error('legacy command') } })
  const kk = h.load('plugins/kk.js')
  await new Promise(resolve => setImmediate(resolve))
  const registrations = h.registry.filter(command => command.pattern === 'kk')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].fn, kk.unwrap)
  assert.deepEqual(Array.from(registrations[0].alias), ['unwrap', 'readvo'])
})

test('status limits apply to protobuf lengths/timestamps; revokes match observed PN/LID aliases', async t => {
  const h = setup(t)
  await h.run('savedelstat', 'on')
  const old = status('expired')
  old.messageTimestamp = { low: Math.floor(Date.now() / 1000) - 90000, high: 0 }
  await h.receive(old)
  const big = status('oversized')
  big.message.imageMessage.fileLength = { low: 17 * 1024 * 1024, high: 0 }
  await h.receive(big)
  assert.equal(h.state.downloads, 0)
  const raw = status('aliases')
  raw.key.participantAlt = '233240000003@s.whatsapp.net'
  await h.receive(raw)
  await h.revoke({ ...raw.key, participant: raw.key.participantAlt, participantAlt: undefined })
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].payload.caption, /Ama Mensah/)
})

test('savedelstat off clears the cache even if a download was already in flight', async t => {
  const h = setup(t)
  await h.run('savedelstat', 'on')
  let finish
  h.state.wait = new Promise(resolve => { finish = resolve })
  const receiving = h.receive(status('in-flight'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.state.downloads, 1)
  await h.run('savedelstat', 'off')
  await h.run('savedelstat', 'on')
  finish()
  await receiving
  assert.equal(h.engine.cacheStats().items, 0)
  await h.revoke(status('in-flight').key)
  assert.equal(h.sent.length, 0)
})

test('top-level encrypted status uses the native message pipeline and retains status ACK class', async t => {
  const h = setup(t), node = { tag: 'status', attrs: { from: 'status@broadcast', participant: '900003@lid', id: 'raw' },
    content: [{ tag: 'enc', attrs: { type: 'skmsg' } }] }
  const forwarded = []
  h.socket.__saffulStatusAckFallback = true
  h.socket.ws.on('CB:message', raw => forwarded.push(raw))
  h.socket.ws.emit('CB:status,from:status@broadcast', node)
  assert.equal(forwarded.length, 0)
  await h.run('savestatus', 'on')
  h.socket.ws.emit('CB:status,from:status@broadcast', node)
  assert.equal(forwarded[0], node)
  assert.equal(forwarded[0].tag, 'status')
})

test('E2E: pinned Baileys decodes status envelopes, forwards named media and recovers a protocol revoke', async t => {
  const h = setup(t)
  const { WebSocketClient } = require('@whiskeysockets/baileys/lib/Socket/Client/websocket.js')
  const frames = []
  t.mock.method(WebSocketClient.prototype, 'connect', function () {
    this.socket = { readyState: 1, send(bytes, done) { frames.push(bytes); done() } }
  })
  t.mock.method(WebSocketClient.prototype, 'close', async function () { this.socket = null })
  const creds = baileys.initAuthCreds()
  creds.me = { id: sudo, lid: '900001@lid' }
  const socket = baileys.default({ auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger: require('pino')({ level: 'silent' }) })
  t.after(() => socket.end())
  // Let the socket's nextTick initialization run before delivering packets or
  // ending it; otherwise it can start a fresh buffer after teardown.
  await new Promise(resolve => setImmediate(resolve))
  // Simulate the cryptographic boundary and media transport; exercise the real
  // Baileys decoder, buffering, receipt encoder and revoke event handling.
  socket.signalRepository.decryptGroupMessage = async ({ group, msg }) => {
    assert.equal(group, 'status@broadcast')
    return Buffer.concat([msg, Buffer.from([1])])
  }
  socket.sendMessage = h.socket.sendMessage
  require('../lib/safful-reconnect-watchdog').watch(socket)
  h.engine.attach(socket)
  socket.ev.emit('contacts.upsert', [{ id: '900003@lid', name: 'Ama Mensah', notify: 'Profile name' }])
  await h.run('savestatus', 'on')
  await h.run('savedelstat', 'on')
  async function packet(id, message) {
    const node = { tag: 'status', attrs: { id, from: 'status@broadcast', participant: '900003@lid',
      t: String(Math.floor(Date.now() / 1000)), type: 'media' },
    content: [{ tag: 'enc', attrs: { type: 'skmsg' }, content: baileys.proto.Message.encode(message).finish() }] }
    const received = new Promise(resolve => socket.ev.on('messages.upsert', resolve))
    socket.ws.emit('CB:status', node)
    socket.ws.emit('CB:status,from:status@broadcast', node)
    await Promise.race([received, new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(Error('Baileys did not emit the status')), 2000)
      timeout.unref()
    })])
    await h.engine.idle()
  }
  await packet('wire-image', status('wire-image').message)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].payload.caption, /Status from Ama Mensah/)
  assert.equal(h.engine.cacheStats().items, 1)
  await packet('wire-revoke', { protocolMessage: { type: 0, key: status('wire-image').key } })
  assert.equal(h.sent.length, 2)
  assert.match(h.sent[1].payload.caption, /Deleted status from Ama Mensah/)
  assert.equal(h.engine.cacheStats().items, 0)
  const packets = await Promise.all(frames.map((frame, i) =>
    baileys.decodeBinaryNode(frame.subarray(3 + (i === 0 ? baileys.NOISE_WA_HEADER.length : 0)))))
  assert.equal(packets.filter(node => node.tag === 'ack' && node.attrs.class === 'status').length, 2)
  assert.ok(!packets.some(node => node.tag === 'ack' && node.attrs.class === 'message'))
})
