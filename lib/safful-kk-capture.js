'use strict'

// Always-on view-once capture.
//
// A view-once message is only decryptable while the original stanza (with its
// 32-byte mediaKey) is available and the CDN object has not been deleted after
// viewing. Waiting for `.kk` to run is therefore a race that is usually lost:
// the reply quote is stripped of mediaKey/directPath, the store may have been
// trimmed, and WhatsApp removes the media once it is opened.
//
// This module copies every view-once message at arrival and downloads the
// bytes immediately, before anything can consume or expire them. `.kk` then
// only has to send the stored bytes; no network, no phone round-trip.
//
// Storage: temp/kk-capture/<message-id>.json + <message-id>.bin
// Disable with SAFFUL_KK_CAPTURE=0. Tune with SAFFUL_KK_CAPTURE_MAX_MB,
// SAFFUL_KK_CAPTURE_MAX and SAFFUL_KK_CAPTURE_TTL_HOURS.

const fs = require('fs')
const path = require('path')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { retrieve, hasMediaKey, statusCode, logLine } = require('./safful-kk-media')

const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.SAFFUL_KK_CAPTURE || '1'))
const ROOT = process.env.SAFFUL_KK_CAPTURE_DIR
  ? path.resolve(process.env.SAFFUL_KK_CAPTURE_DIR)
  : path.join(__dirname, '..', 'temp', 'kk-capture')
const MAX_BYTES = Math.max(1, Number(process.env.SAFFUL_KK_CAPTURE_MAX_MB) || 64) * 1024 * 1024
const MAX_ENTRIES = Math.max(20, Number(process.env.SAFFUL_KK_CAPTURE_MAX) || 300)
const TTL_MS = Math.max(1, Number(process.env.SAFFUL_KK_CAPTURE_TTL_HOURS) || 72) * 60 * 60 * 1000
const MAX_JSON = 512 * 1024
const CONCURRENCY = 2

const memory = new Map()
const inflight = new Set()
const queue = []
let active = 0
let prunedAt = 0

function log(...parts) {
  logLine('[capture]', ...parts)
}

function normalize(jid) {
  return String(jid || '').replace(/:\d+@/, '@').trim()
}

function sameChat(a, b) {
  return Boolean(a && b) && normalize(a) === normalize(b)
}

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)
}

function jsonPath(id) {
  return path.join(ROOT, safeId(id) + '.json')
}

function binPath(id) {
  return path.join(ROOT, safeId(id) + '.bin')
}

function ensureRoot() {
  try { fs.mkdirSync(ROOT, { recursive: true }) } catch {}
}

function pickMedia(media) {
  const copy = {}
  for (const key of ['mimetype', 'caption', 'ptt', 'fileName', 'fileLength',
    'seconds', 'pageCount', 'width', 'height', 'isAnimated']) {
    if (media?.[key] !== undefined) copy[key] = media[key]
  }
  return copy
}

function serializable(raw) {
  try {
    const text = JSON.stringify(raw, (_key, value) => {
      if (Buffer.isBuffer(value)) return { type: 'Buffer', data: [...value] }
      return value
    })
    if (!text || text.length > MAX_JSON) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function saveEntry(entry) {
  if (!entry?.id) return
  ensureRoot()
  const target = jsonPath(entry.id)
  const temporary = target + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry), 'utf8')
    fs.renameSync(temporary, target)
  } catch (error) {
    log('write-failed', entry.id, error?.message || String(error))
  }
}

function loadEntry(id) {
  if (!id) return null
  if (memory.has(id)) return memory.get(id)
  try {
    const entry = JSON.parse(fs.readFileSync(jsonPath(id), 'utf8'))
    if (entry?.id === id) {
      memory.set(id, entry)
      return entry
    }
  } catch {}
  return null
}

function readBin(entry) {
  if (!entry?.captured) return null
  try {
    const file = binPath(entry.id)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function prune(force = false) {
  const now = Date.now()
  if (!force && now - prunedAt < 60 * 1000) return
  prunedAt = now
  let names
  try { names = fs.readdirSync(ROOT) } catch { return }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
    const id = name.slice(0, -5)
    let entry
    try { entry = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8')) } catch { continue }
    if (!entry?.id) continue
    if (now - Number(entry.receivedAt || 0) > TTL_MS) {
      removeEntry(entry.id)
      continue
    }
    entries.push(entry)
  }
  if (entries.length <= MAX_ENTRIES) return
  entries.sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0))
  for (const entry of entries.slice(0, entries.length - MAX_ENTRIES)) removeEntry(entry.id)
}

function removeEntry(id) {
  memory.delete(id)
  for (const file of [jsonPath(id), binPath(id), jsonPath(id) + '.tmp']) {
    try { fs.unlinkSync(file) } catch {}
  }
}

function enqueue(socket, entry, options) {
  queue.push({ socket, entry, options })
  pump()
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()
    active += 1
    void download(job.socket, job.entry, job.options)
      .catch(error => log('download-crash', job.entry?.id, error?.message || String(error)))
      .finally(() => { active -= 1; pump() })
  }
}

async function download(socket, entry, options = {}) {
  if (!entry?.id || inflight.has(entry.id)) return
  inflight.add(entry.id)
  try {
    // Use the live copy for the download; the serialized copy may have been
    // dropped when a message exceeded the JSON size limit.
    const raw = options.raw || entry.raw
    const detected = detectViewOnce(raw)
    if (!detected) return
    const result = options.download
      ? await options.download(raw, detected)
      : await retrieve(socket, raw, detected)
    const bytes = Buffer.isBuffer(result) ? result : result?.bytes
    if (!bytes?.length) throw Object.assign(Error('Empty capture'), { code: 'KK_EMPTY' })
    if (bytes.length > MAX_BYTES) throw Object.assign(Error('Capture too large'), { code: 'KK_TOO_LARGE' })
    ensureRoot()
    fs.writeFileSync(binPath(entry.id), bytes)
    entry.captured = true
    entry.bytes = bytes.length
    entry.reason = ''
    entry.media = { ...entry.media, ...pickMedia(detected.media) }
    memory.set(entry.id, entry)
    saveEntry(entry)
    log('captured', entry.id, entry.kind || '', bytes.length + 'B', 'source=' + (entry.source || 'unknown'))
  } catch (error) {
    entry.reason = error?.code || (statusCode(error) ? 'http-' + statusCode(error) : '') ||
      String(error?.message || error).slice(0, 120)
    entry.captured = false
    memory.set(entry.id, entry)
    saveEntry(entry)
    log('capture-failed', entry.id, entry.reason)
  } finally {
    inflight.delete(entry.id)
  }
}

// Copy and record a view-once message. Returns the stored entry (or null when
// the message is not view-once). `options.download` is a test seam.
function ingest(socket, raw, source = 'upsert', options = {}) {
  if (!ENABLED || !raw || typeof raw !== 'object') return null
  const id = raw.key?.id
  if (!id) return null
  let copy
  try { copy = structuredClone(raw) } catch { copy = raw }
  const detected = detectViewOnce(copy)
  if (!detected) return null
  const keyed = hasMediaKey(detected.media)
  const previous = loadEntry(id)
  // Never let a late stub overwrite bytes we already captured.
  if (previous?.captured && !keyed) return previous
  const entry = {
    version: 1,
    id,
    chat: raw.key?.remoteJid || '',
    chatAlt: raw.key?.remoteJidAlt || '',
    participant: raw.key?.participant || '',
    participantAlt: raw.key?.participantAlt || '',
    fromMe: Boolean(raw.key?.fromMe),
    receivedAt: previous?.captured ? previous.receivedAt : Date.now(),
    source,
    type: detected.type,
    kind: detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', ''),
    hasKey: keyed,
    reason: keyed ? '' : 'no-media-key',
    media: pickMedia(detected.media),
    raw: serializable(copy),
    captured: Boolean(previous?.captured),
    bytes: previous?.bytes || 0,
  }
  memory.set(id, entry)
  saveEntry(entry)
  log('seen', id, entry.kind, 'key=' + keyed, 'source=' + source)
  if (keyed && !entry.captured) enqueue(socket, entry, { ...options, raw: copy })
  prune()
  return entry
}

// An unavailable fanout carries no payload at all. Remember it so `.kk` can
// explain the real reason instead of pretending a key was lost locally.
function noteUnavailable(key, type = 'view_once') {
  if (!ENABLED || !key?.id) return null
  const previous = loadEntry(key.id)
  if (previous?.captured) return previous
  const entry = {
    version: 1,
    id: key.id,
    chat: key.remoteJid || '',
    chatAlt: key.remoteJidAlt || '',
    participant: key.participant || '',
    participantAlt: key.participantAlt || '',
    fromMe: Boolean(key.fromMe),
    receivedAt: Date.now(),
    source: 'unavailable',
    type: '',
    kind: '',
    hasKey: false,
    reason: 'unavailable:' + String(type || 'view_once'),
    media: {},
    raw: null,
    captured: false,
    bytes: 0,
  }
  memory.set(key.id, entry)
  saveEntry(entry)
  log('unavailable', key.id, entry.reason)
  return entry
}

// Read a capture. Message ids are unique, so the id is the primary key; the
// chat is only used to prefer the right entry and to reject obvious mismatches.
async function read(chat, id) {
  if (!id) return null
  const entry = loadEntry(id)
  if (!entry) return null
  if (chat && entry.chat && !sameChat(entry.chat, chat) && !sameChat(entry.chatAlt, chat)) {
    log('chat-mismatch', id, 'stored=' + entry.chat, 'asked=' + chat)
  }
  const bytes = readBin(entry)
  return { entry, raw: entry.raw, reason: entry.reason || '', bytes: bytes || null }
}

function status() {
  prune(true)
  let entries = 0
  let captured = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(ROOT)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      entries += 1
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))
        if (entry?.captured) { captured += 1; bytes += Number(entry.bytes || 0) }
      } catch {}
    }
  } catch {}
  return { enabled: ENABLED, directory: ROOT, entries, captured, bytes, pending: inflight.size, queued: queue.length }
}

function attach(socket) {
  if (!socket || socket.__saffulKkCaptureAttached) return socket
  socket.__saffulKkCaptureAttached = true
  if (!ENABLED) return socket
  ensureRoot()
  prune(true)

  const handle = (event, data) => {
    if (event === 'messages.upsert' || event === 'messaging-history.set') {
      for (const raw of data?.messages || []) ingest(socket, raw, event)
      return
    }
    if (event === 'messages.update') {
      for (const item of data || []) {
        if (!item?.update?.message) continue
        ingest(socket, { ...item.update, key: { ...item.key, ...(item.update.key || {}) } }, event)
      }
    }
  }

  // Run before the legacy dispatcher so the copy is taken while the wrapper and
  // the media key are still intact. The detector wraps emit the same way; the
  // wrappers chain, and each one only reads its own copy.
  if (typeof socket.ev?.emit === 'function') {
    const emit = socket.ev.emit.bind(socket.ev)
    socket.ev.emit = (event, data) => {
      try { handle(event, data) } catch (error) { log('emit-error', error?.message || String(error)) }
      return emit(event, data)
    }
  } else if (typeof socket.ev?.on === 'function') {
    socket.ev.on('messages.upsert', data => handle('messages.upsert', data))
    socket.ev.on('messages.update', data => handle('messages.update', data))
  }

  // Baileys ACKs some unavailable view-once fanouts without an upsert.
  try {
    socket.ws?.on?.('CB:message', node => {
      const unavailable = Array.isArray(node?.content) && node.content.find(child => child.tag === 'unavailable')
      const type = unavailable?.attrs?.type || ''
      if (!/^view_once(?:_unavailable_fanout)?$/.test(type)) return
      noteUnavailable({
        id: node.attrs?.id,
        remoteJid: node.attrs?.from,
        participant: node.attrs?.participant,
        participantAlt: node.attrs?.participant_pn,
        remoteJidAlt: node.attrs?.sender_pn,
      }, type)
    })
  } catch {}

  log('attached', 'dir=' + ROOT)
  return socket
}

module.exports = { attach, ingest, read, noteUnavailable, status, prune, ENABLED, ROOT }
