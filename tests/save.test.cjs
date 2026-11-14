'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const filename = path.resolve(__dirname, '..', 'plugins', 'save.js')
const sudo = '233240000001@s.whatsapp.net'

function load(download) {
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    Buffer, console, process,
    require: key => {
      if (key === '../lib/plugins') return { cmd() {} }
      if (key === '../lib/safful-identities') return { isOperator: async () => true, ownerJids: () => [sudo] }
      if (key === '@whiskeysockets/baileys') return { downloadContentFromMessage: download }
      if (key === '../lib/safful-status-media') {
        const helper = { exports: {} }
        vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../lib/safful-status-media.js'), 'utf8'), {
          module: helper, Buffer, require: () => ({ downloadContentFromMessage: download }),
        })
        return helper.exports
      }
      throw Error(key)
    },
  }, { filename })
  return module.exports
}

function fixture(quoted, original) {
  const sent = [], replies = []
  const socket = { sendMessage: async (jid, payload) => sent.push({ jid, payload }) }
  const message = { bot: socket, quoted, reply: async text => replies.push(text),
    message: { extendedTextMessage: { text: '.save', contextInfo: { stanzaId: 'status-1', remoteJid: 'status@broadcast', quotedMessage: { extendedTextMessage: { text: 'caption only' } } } } } }
  const store = { loadMessage: async (_jid, id) => id === 'status-1' ? original : null }
  return { message, socket, store, sent, replies }
}

test('save prefers original video media over the quoted caption and sends bytes to sudo', async () => {
  const calls = []
  const plugin = load(async (media, kind) => { calls.push([media, kind]); return (async function* () { yield Buffer.from('video bytes') })() })
  const original = { key: { id: 'status-1', remoteJid: 'status@broadcast' }, message: { ephemeralMessage: { message: { videoMessage: { caption: 'real caption', directPath: '/video', mediaKey: Buffer.alloc(32) } } } } }
  const h = fixture({ message: { extendedTextMessage: { text: 'caption only' } } }, original)
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'video')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].jid, sudo)
  assert.equal(h.sent[0].payload.video.toString(), 'video bytes')
  assert.equal(h.sent[0].payload.caption, 'real caption')
})

test('save finds image in nested quoted payload without an original store entry', async () => {
  const plugin = load(async () => (async function* () { yield Buffer.from('image bytes') })())
  const h = fixture({ message: { viewOnceMessageV2: { message: { imageMessage: { caption: 'pic', directPath: '/image' } } } } }, null)
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(h.sent[0].payload.image.toString(), 'image bytes')
})

test('save does not send a caption when media download fails', async () => {
  const plugin = load(async () => { throw new Error('media expired') })
  const h = fixture({ message: { audioMessage: { directPath: '/old' } } }, null)
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(h.sent.length, 0)
  assert.match(h.replies[0], /Status download failed/)
})

test('save supports true text statuses and document media', async () => {
  const plugin = load(async () => (async function* () { yield Buffer.from('document bytes') })())
  const text = fixture({ message: { conversation: 'A real text status' } }, null)
  await plugin.save(text.message, '', { store: text.store })
  assert.equal(text.sent[0].payload.text, 'A real text status')
  const doc = fixture({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'note.pdf', mimetype: 'application/pdf' } } } } }, null)
  await plugin.save(doc.message, '', { store: doc.store })
  assert.equal(doc.sent[0].payload.document.toString(), 'document bytes')
})

test('save refuses caption-only quoted text when original status media is unavailable', async () => {
  const plugin = load(async () => { throw new Error('download should not run') })
  const h = fixture({ message: { extendedTextMessage: { text: 'just the caption' } } }, null)
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(h.sent.length, 0)
  assert.match(h.replies[0], /No status media found/)
})

test('save retries an expired media URL after WhatsApp re-uploads the original', async () => {
  let downloads = 0, reuploads = 0
  const plugin = load(async () => {
    downloads++
    if (downloads === 1) throw Object.assign(new Error('gone'), { status: 410 })
    return (async function* () { yield Buffer.from('restored video') })()
  })
  const original = { key: { id: 'status-1', remoteJid: 'status@broadcast' }, message: { videoMessage: { directPath: '/expired' } } }
  const h = fixture({ message: { extendedTextMessage: { text: 'caption' } } }, original)
  h.socket.updateMediaMessage = async message => {
    reuploads++
    assert.equal(message.key.id, 'status-1')
    return { ...message, message: { videoMessage: { directPath: '/fresh' } } }
  }
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(reuploads, 1)
  assert.equal(downloads, 2)
  assert.equal(h.sent[0].payload.video.toString(), 'restored video')
})

test('save uses media in the raw reply context when serialized quote only exposes caption', async () => {
  const plugin = load(async () => (async function* () { yield Buffer.from('raw image') })())
  const h = fixture({ message: { extendedTextMessage: { text: 'caption only' } } }, null)
  h.message.message.extendedTextMessage.contextInfo.quotedMessage = {
    ephemeralMessage: { message: { imageMessage: { caption: 'picture', directPath: '/raw' } } },
  }
  await plugin.save(h.message, '', { store: h.store })
  assert.equal(h.sent[0].payload.image.toString(), 'raw image')
})
