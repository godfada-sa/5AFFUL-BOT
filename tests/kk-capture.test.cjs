'use strict'

// Isolate the capture store so the real temp/kk-capture is never touched.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-kk-capture-'))
process.env.SAFFUL_KK_CAPTURE_DIR = root
process.env.SAFFUL_KK_LOG = path.join(root, 'kk.log')

const capture = require('../lib/safful-kk-capture')

const chat = '120363000000000000@g.us'
const mediaKey = Buffer.alloc(32, 7)
const plaintext = Buffer.from('captured view-once bytes')

function viewOnce(id, extra = {}) {
  return {
    key: { id, remoteJid: chat, fromMe: false, isViewOnce: true },
    message: { viewOnceMessageV2: { message: {
      imageMessage: {
        viewOnce: true, directPath: '/v/t62/' + id, mediaKey,
        fileLength: plaintext.length, mimetype: 'image/jpeg', ...extra,
      },
    } } },
  }
}

async function waitFor(predicate, ms = 3000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('captures view-once bytes at arrival and reads them back', async () => {
  capture.ingest(null, viewOnce('capture-1'), 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'capture-1'))?.bytes)))
  const found = await capture.read(chat, 'capture-1')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.captured, true)
  assert.equal(found.entry.kind, 'image')
  assert.equal(found.entry.media.mimetype, 'image/jpeg')
})

test('records a stripped view-once without inventing bytes', async () => {
  let downloads = 0
  capture.ingest(null, viewOnce('stub-1', { mediaKey: undefined }), 'upsert', {
    download: async () => { downloads += 1; throw Error('must not download') },
  })
  const found = await capture.read(chat, 'stub-1')
  assert.equal(found.bytes, null)
  assert.equal(found.entry.hasKey, false)
  assert.equal(found.reason, 'no-media-key')
  assert.equal(downloads, 0)
})

test('a later stub never overwrites captured bytes', async () => {
  capture.ingest(null, viewOnce('capture-2'), 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'capture-2'))?.bytes)))
  capture.ingest(null, viewOnce('capture-2', { mediaKey: undefined }), 'upsert')
  const found = await capture.read(chat, 'capture-2')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.captured, true)
})

test('unavailable fanout is recorded with its real reason', async () => {
  capture.noteUnavailable({ id: 'stub-2', remoteJid: chat }, 'view_once_unavailable_fanout')
  const found = await capture.read(chat, 'stub-2')
  assert.equal(found.bytes, null)
  assert.equal(found.reason, 'unavailable:view_once_unavailable_fanout')
})

test('non view-once messages are ignored', () => {
  const before = capture.status().entries
  capture.ingest(null, { key: { id: 'plain-1', remoteJid: chat }, message: { conversation: 'hi' } }, 'upsert')
  assert.equal(capture.status().entries, before)
})

test('attach copies the message before the dispatcher can strip it', async () => {
  const { EventEmitter } = require('node:events')
  const ev = new EventEmitter()
  const socket = { ev, ws: new EventEmitter() }
  capture.attach(socket)
  // The legacy dispatcher mutates the message after receiving the event.
  ev.on('messages.upsert', data => { for (const message of data.messages) delete message.message })
  ev.emit('messages.upsert', { messages: [viewOnce('attach-1', { mediaKey: undefined })] })
  const found = await capture.read(chat, 'attach-1')
  assert.ok(found, 'entry was recorded before the dispatcher stripped the message')
  assert.equal(found.entry.hasKey, false)
  assert.equal(found.reason, 'no-media-key')
})
