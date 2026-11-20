'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { createRequire } = require('node:module')
const baileys = require('@whiskeysockets/baileys')
const filename = path.resolve(__dirname, '../plugins/kk.js')
const sudo = '233240000001@s.whatsapp.net'
const mediaKey = Buffer.alloc(32, 4)
const plaintext = Buffer.from('received view-once media bytes')

function harness() {
  const module = { exports: {} }, commands = [], sent = [], replies = [], logs = [], state = {}
  const native = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename, console, Buffer, global: {},
    process: { stderr: { write: line => logs.push(line) } }, setImmediate,
    require: name => {
      if (name === '../lib/plugins') return { commands, cmd: (options, fn) => {
        const command = { ...options, fn }; commands.push(command); return command
      } }
      if (name === '../lib/safful-identities') return { ownerJids: () => [sudo] }
      if (name === '../lib/safful-protection') return { readCapturedViewOnce: async () => state.cache || null }
      if (name === '../lib/safful-kk-capture') return {
        read: async () => state.captured || null,
        status: () => ({ enabled: true, entries: 1, captured: 1, bytes: plaintext.length, pending: 0 }),
      }
      return native(name)
    },
  }, { filename })
  const relayed = []
  const socket = { sendMessage: async (to, payload) => {
    if (state.failAll || (state.failMedia && !payload.text)) throw Object.assign(Error('private transport failed'), { status: 500 })
    sent.push({ to, payload })
  }, relayMessage: async (to, content, options) => {
    if (state.failRelay) throw Object.assign(Error('relay failed'), { status: 500 })
    relayed.push({ to, content, options })
    return 'relay-id'
  } }
  const key = { id: 'original', remoteJid: 'team@g.us', participant: '900003@lid' }
  const original = (media = {}) => ({ key, message: { viewOnceMessageV2: { message: {
    imageMessage: { viewOnce: true, directPath: '/valid', mediaKey, ...media },
  } } } })
  const message = { chat: key.remoteJid, bot: socket, quoted: original(), reply: async text => replies.push(text) }
  return { ...module.exports, sent, relayed, replies, logs, state, socket, key, original, message }
}
async function encrypted(kind = 'image') {
  const { cipherKey, iv, macKey } = await baileys.getMediaKeys(mediaKey, kind)
  const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10)
  return Buffer.concat([ciphertext, mac])
}

test('E2E: kk relays the stored original with viewOnce cleared instead of downloading it', async t => {
  const h = harness()
  t.mock.method(global, 'fetch', async () => { throw Error('relaying must not download') })
  h.message.quoted = h.original({ mediaKey: { type: 'Buffer', data: mediaKey.toString('base64') } })
  await h.unwrap(h.message, '')
  assert.equal(h.relayed.length, 1)
  assert.equal(h.relayed[0].to, sudo)
  const image = h.relayed[0].content.imageMessage
  assert.equal(image.viewOnce, undefined, 'the relayed copy must not be view-once again')
  assert.ok(Buffer.isBuffer(image.mediaKey) && image.mediaKey.length === 32, 'keeps the original key for the recipient')
  assert.equal(image.directPath, '/valid')
  assert.equal(h.sent.length, 0, 'nothing is sent through the media path')
  assert.equal(h.replies.length, 0)
})

test('kk never asks the phone to resend a view-once stub', async t => {
  const h = harness()
  t.mock.method(global, 'fetch', async () => { throw Error('must not fetch without keys') })
  h.message.quoted = { key: h.key, message: { viewOnceMessageV2: { message: {
    imageMessage: { viewOnce: true, caption: 'hello' },
  } } } }
  let asked = 0
  h.socket.requestPlaceholderResend = async () => { asked += 1; return 'request-id' }
  h.socket.sendPeerDataOperationMessage = async () => { asked += 1; return 'request-id' }
  await h.unwrap(h.message, '')
  assert.equal(asked, 0, 'a view-once stub is unrecoverable from the phone, so it is not requested')
  assert.match(h.sent[0].payload.text, /Original media unavailable/)
  assert.equal(h.sent[0].to, sudo)
  assert.equal(h.replies.length, 0)
})

test('kk uses media captured at arrival when the relay cannot run', async t => {
  const h = harness()
  t.mock.method(global, 'fetch', async () => { throw Error('network must not be used') })
  h.state.failRelay = true
  h.state.captured = {
    entry: { type: 'imageMessage', kind: 'image', media: { mimetype: 'image/jpeg' } },
    raw: null, reason: '', bytes: plaintext,
  }
  await h.unwrap(h.message, '')
  assert.deepEqual(h.sent[0].payload.image, plaintext)
  assert.equal(h.sent[0].to, sudo)
})

test('kk recovers cached bytes when quotes are stripped, without fetching or growing a new disk cache', async t => {
  const h = harness()
  h.socket.relayMessage = undefined // the cached copy is all that is left
  t.mock.method(global, 'fetch', async () => { throw Error('network must not be used') })
  h.state.cache = { raw: h.original(), bytes: plaintext }
  h.message.quoted = { key: h.key, message: { conversation: 'stripped' } }
  await h.unwrap(h.message, '')
  assert.deepEqual(h.sent[0].payload.image, plaintext)
  assert.equal(h.sent[0].to, sudo)
})

test('kk tries a usable original when another candidate fails and the first store lookup returns nothing', async t => {
  const h = harness(), bytes = await encrypted(), urls = []
  h.socket.relayMessage = undefined // exercises the decrypt fallback
  t.mock.method(global, 'fetch', async url => {
    urls.push(url)
    return String(url).endsWith('/old') ? new Response('', { status: 410 }) : new Response(bytes)
  })
  h.message.quoted = h.original({ directPath: '/old' })
  await h.unwrap(h.message, '', { store: {
    loadMessage: async () => null,
    getMessages: async () => h.original(),
  } })
  assert.equal(urls.length, 2)
  assert.deepEqual(h.sent[0].payload.image, plaintext)
  assert.equal(h.replies.length, 0)
})

test('kk refreshes HTTP 403 with the original group key and normalized media', async t => {
  const h = harness(), bytes = await encrypted()
  h.socket.relayMessage = undefined // exercises the decrypt fallback
  t.mock.method(global, 'fetch', async url => String(url).endsWith('/fresh') ? new Response(bytes) : new Response('', { status: 403 }))
  let refreshed = 0
  h.socket.updateMediaMessage = async raw => {
    refreshed++
    assert.deepEqual(raw.key, h.key)
    assert.ok(baileys.assertMediaContent(raw.message))
    raw.message.imageMessage.directPath = '/fresh'
    return raw
  }
  await h.unwrap(h.message, '')
  assert.equal(refreshed, 1)
  assert.deepEqual(h.sent[0].payload.image, plaintext)
})

test('duplicate expired quotes do not exhaust the recovery limit before a usable original', async t => {
  const h = harness(), bytes = await encrypted(), urls = []
  h.socket.relayMessage = undefined // exercises the decrypt fallback
  t.mock.method(global, 'fetch', async url => {
    urls.push(url)
    return String(url).endsWith('/old') ? new Response('', { status: 410 }) : new Response(bytes)
  })
  const old = h.original({ directPath: '/old' })
  h.state.cache = { raw: old }
  h.message.quoted = { ...old, fakeObj: old }
  h.message.fakeObj = { message: { extendedTextMessage: { contextInfo: {
    stanzaId: h.key.id, participant: h.key.participant, quotedMessage: old.message,
  } } } }
  await h.unwrap(h.message, '', { store: {
    loadMessage: async () => old,
    getMessages: async () => h.original(),
  } })
  assert.equal(urls.length, 2)
  assert.deepEqual(h.sent[0].payload.image, plaintext)
})

test('kk handles mtype/msg quotes and requests a missing URL using its original media key', async t => {
  const h = harness(), bytes = await encrypted()
  t.mock.method(global, 'fetch', async () => new Response(bytes))
  h.message.quoted = { key: h.key, mtype: 'imageMessage', msg: { viewOnce: true, mediaKey } }
  h.socket.updateMediaMessage = async raw => {
    assert.equal(raw.key.id, 'original')
    raw.message.imageMessage.directPath = '/fresh'
    return raw
  }
  await h.unwrap(h.message, '')
  assert.deepEqual(h.sent[0].payload.image, plaintext)
})

test('kk refreshes and decrypts a video note through the supported video media assertion', async t => {
  const h = harness(), bytes = await encrypted('video')
  h.socket.relayMessage = undefined // exercises the decrypt fallback
  t.mock.method(global, 'fetch', async url => String(url).endsWith('/fresh') ? new Response(bytes) : new Response('', { status: 410 }))
  h.message.quoted = { key: { ...h.key, isViewOnce: true }, message: {
    ptvMessage: { directPath: '/expired', mediaKey: { type: 'Buffer', data: [...mediaKey] } },
  } }
  h.socket.updateMediaMessage = async raw => {
    assert.ok(baileys.assertMediaContent(raw.message))
    assert.equal(raw.message.ptvMessage, undefined)
    assert.equal(raw.key.id, h.key.id)
    raw.message.videoMessage.directPath = '/fresh'
    return raw
  }
  await h.unwrap(h.message, '')
  assert.equal(h.sent[0].to, sudo)
  assert.deepEqual(h.sent[0].payload.video, plaintext)
  assert.equal(h.replies.length, 0)
})

test('kk explains missing keys privately without attempting impossible downloads', async t => {
  const h = harness()
  t.mock.method(global, 'fetch', async () => { throw Error('must not fetch without keys') })
  h.message.quoted = h.original({ mediaKey: undefined, directPath: undefined })
  await h.unwrap(h.message, '')
  assert.equal(h.sent[0].to, sudo)
  assert.match(h.sent[0].payload.text, /Original media unavailable/)
  assert.equal(h.replies.length, 0)
})

test('delivery errors stay private and are distinguished from retrieval failures', async t => {
  const h = harness()
  h.socket.relayMessage = undefined // the cached copy is all that is left
  h.state.cache = { raw: h.original(), bytes: plaintext }
  h.state.failMedia = true
  await h.unwrap(h.message, '')
  assert.equal(h.sent[0].to, sudo)
  assert.match(h.sent[0].payload.text, /Could not send media to sudo/)
  h.state.failAll = true
  await assert.doesNotReject(h.unwrap(h.message, ''))
  assert.equal(h.replies.length, 0)
  assert.equal(h.logs.length, 1)
})

test('kk downloads media that carries only a full https CDN url', async t => {
  const h = harness(), bytes = await encrypted(), urls = []
  h.socket.relayMessage = undefined // exercises the decrypt fallback
  t.mock.method(global, 'fetch', async url => { urls.push(String(url)); return new Response(bytes) })
  h.message.quoted = { key: h.key, message: { viewOnceMessageV2: { message: {
    imageMessage: { viewOnce: true, mediaKey, url: 'https://mmg.whatsapp.net/v/t62/abc?x=1' },
  } } } }
  await h.unwrap(h.message, '')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /\/v\/t62\/abc/)
  assert.deepEqual(h.sent[0].payload.image, plaintext)
})

test('kk sends bytes captured at arrival without fetching or asking the phone', async t => {
  const h = harness()
  t.mock.method(global, 'fetch', async () => { throw Error('network must not be used') })
  h.state.captured = {
    entry: { type: 'imageMessage', kind: 'image', media: { mimetype: 'image/jpeg', caption: 'captured' } },
    raw: null, reason: '', bytes: plaintext,
  }
  // The reply quote is exactly what WhatsApp now sends: no key, no directPath.
  h.message.quoted = { key: h.key, message: { conversation: 'stripped' } }
  h.socket.requestPlaceholderResend = async () => { throw Error('phone must not be asked') }
  await h.unwrap(h.message, '')
  assert.equal(h.sent[0].to, sudo)
  assert.deepEqual(h.sent[0].payload.image, plaintext)
  assert.equal(h.sent[0].payload.caption, 'captured')
  assert.equal(h.replies.length, 0)
})

test('kk explains an unavailable fanout instead of blaming the key', async () => {
  const h = harness()
  h.state.captured = {
    entry: { type: '', kind: '', media: {} }, raw: null,
    reason: 'unavailable:view_once_unavailable_fanout', bytes: null,
  }
  h.message.quoted = { key: h.key, message: { viewOnceMessageV2: { message: {
    imageMessage: { viewOnce: true },
  } } } }
  h.socket.ev = { on: () => {}, off: () => {} }
  h.socket.requestPlaceholderResend = async () => 'request-id'
  await h.unwrap(h.message, '')
  assert.equal(h.sent[0].to, sudo)
  assert.match(h.sent[0].payload.text, /never received the view-once media/)
  assert.equal(h.replies.length, 0)
})

test('kk status reports the capture state privately', async () => {
  const h = harness()
  await h.unwrap(h.message, 'status')
  assert.equal(h.sent[0].to, sudo)
  assert.match(h.sent[0].payload.text, /Capture ON/)
  assert.match(h.sent[0].payload.text, /decrypted 1/)
})
