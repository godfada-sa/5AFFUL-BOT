'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), vm = require('vm'), os = require('os')
const root = path.resolve(__dirname, '..')
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astatus-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const state = { downloads: [], fail: false, owner: true, writeFail: false }, registry = []
  const settings = path.join(dir, 'settings.json')
  function load(file) {
    const mod = { exports: {} }, filename = path.join(root, file)
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: mod, Buffer, __dirname: path.dirname(filename), process: { env: { SAFFUL_ASTATUS_FILE: settings } },
      console: { error() {} }, require: name => {
        if (name === '../lib/plugins') return { cmd: (options, fn) => registry.push({ options, fn }) }
        if (name === '../lib/safful-identities') return { isOperator: async () => state.owner }
        if (name === '../lib/safful-status-media') return load('lib/safful-status-media.js')
        if (name === '@whiskeysockets/baileys') return { downloadContentFromMessage: async (media, kind) => {
          state.downloads.push({ media, kind })
          if (state.fail) throw Error('offline')
          if (media.directPath === '/expired') throw Object.assign(Error('expired'), { status: 410 })
          return (async function* () { yield Buffer.from(kind + ' bytes') })()
        } }
        if (name === 'fs') return { ...fs, writeFileSync: (...args) => {
          if (state.writeFail) throw Error('read only')
          return fs.writeFileSync(...args)
        } }
        return require(name)
      },
    }, { filename })
    return mod.exports
  }
  const plugin = load('plugins/astatus.js'), sent = [], replies = []
  const socket = { sendMessage: async (jid, payload) => sent.push({ jid, payload }) }
  const context = { remoteJid: 'status@broadcast', stanzaId: 's1', participant: '123456789@s.whatsapp.net',
    quotedMessage: { extendedTextMessage: { text: 'caption only' } } }
  const message = { chat: '987654321@s.whatsapp.net', bot: socket, reply: async text => replies.push(text),
    fakeObj: { message: { extendedTextMessage: { contextInfo: context } } } }
  return { plugin, message, context, socket, sent, replies, state, settings, registry }
}

test('astatus recovers stored wrapped video instead of forwarding caption', async t => {
  const h = setup(t)
  h.message.quoted = { key: { remoteJid: 'status@broadcast', id: 's1' }, message: { extendedTextMessage: { text: 'caption' } } }
  const original = { key: { remoteJid: 'status@broadcast', id: 's1' }, message: {
    ephemeralMessage: { message: { videoMessage: { directPath: '/valid', caption: 'real caption' } } } } }
  await h.plugin.autoReply(h.message, 'please send', { store: { loadMessage: async (jid, id) => {
    assert.equal(jid, 'status@broadcast'); assert.equal(id, 's1'); return original
  } } })
  assert.equal(h.sent[0].jid, h.message.chat)
  assert.equal(h.sent[0].payload.video.toString(), 'video bytes')
  assert.equal(h.sent[0].payload.caption, 'real caption')
})

test('raw-context-only replies deliver image, audio, document, sticker and PTV bytes', async t => {
  const h = setup(t)
  for (const [type, kind] of [['imageMessage', 'image'], ['audioMessage', 'audio'],
    ['documentMessage', 'document'], ['stickerMessage', 'sticker'], ['ptvMessage', 'video']]) {
    h.context.quotedMessage = { viewOnceMessageV2: { message: { [type]: { directPath: '/valid', ptt: true } } } }
    await h.plugin.autoReply(h.message, 'snd')
    assert.equal(h.sent.at(-1).payload[kind].toString(), kind + ' bytes')
  }
  assert.equal(h.sent.length, 5)
})

test('text is supported but caption-only and failed downloads never become text sends', async t => {
  const h = setup(t)
  h.context.quotedMessage = { conversation: 'true text status' }
  await h.plugin.autoReply(h.message, 'send')
  assert.equal(h.sent[0].payload.text, 'true text status')
  h.context.quotedMessage = { extendedTextMessage: { text: 'caption only' } }
  await h.plugin.autoReply(h.message, 'send')
  assert.match(h.replies.at(-1), /Status media unavailable/)
  h.state.fail = true
  h.context.quotedMessage = { imageMessage: { directPath: '/valid', caption: 'caption' } }
  await h.plugin.autoReply(h.message, 'send')
  assert.match(h.replies.at(-1), /Could not send this status/)
  assert.equal(h.sent.length, 1)
})

test('expired raw media refresh carries status key and retries download', async t => {
  const h = setup(t)
  h.context.quotedMessage = { videoMessage: { directPath: '/expired' } }
  h.socket.updateMediaMessage = async raw => {
    assert.equal(raw.key.id, 's1'); assert.equal(raw.key.remoteJid, 'status@broadcast')
    assert.equal(raw.key.participant, h.context.participant)
    return { ...raw, message: { videoMessage: { directPath: '/fresh' } } }
  }
  await h.plugin.autoReply(h.message, 'sent')
  assert.equal(h.state.downloads.length, 2)
  assert.equal(h.sent[0].payload.video.toString(), 'video bytes')
})

test('ignores groups, own messages, ordinary quotes and non-trigger text; off persists', async t => {
  const h = setup(t)
  h.context.quotedMessage = { imageMessage: { directPath: '/valid' } }
  await h.plugin.autoReply({ ...h.message, chat: 'team@g.us' }, 'send')
  await h.plugin.autoReply({ ...h.message, key: { fromMe: true } }, 'send')
  await h.plugin.autoReply(h.message, 'hello')
  h.context.remoteJid = h.message.chat
  await h.plugin.autoReply(h.message, 'send')
  h.context.remoteJid = 'status@broadcast'
  h.state.owner = false
  await h.plugin.configure(h.message, 'off')
  assert.equal(h.plugin.getEnabled(), true)
  h.state.owner = true
  await h.plugin.configure(h.message, 'off')
  assert.equal(JSON.parse(fs.readFileSync(h.settings)).enabled, false)
  await h.plugin.autoReply(h.message, 'send')
  assert.equal(h.sent.length, 0)
  h.state.writeFail = true
  await h.plugin.configure(h.message, 'on')
  assert.equal(h.plugin.getEnabled(), false)
  assert.match(h.replies.at(-1), /Could not save settings/)
})
