'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { normalizeMessageContent } = require('@whiskeysockets/baileys')
const { ownerJids, normalizedJid, knownContacts, attachContactCache, indexContacts, resolvePhone } = require('./safful-identities')
const { inspectContent, download, mediaPayload } = require('./safful-status-media')

const settingsFile = path.join(__dirname, 'safful-status-save.json')
const cacheDir = path.join(__dirname, '..', '.safful-data', 'deleted-status')
const MAX_CACHE = 64 * 1024 * 1024
const MAX_ITEM = 16 * 1024 * 1024
const TTL = 24 * 60 * 60 * 1000
const records = new Map()
const sent = new Set()
const attached = new WeakSet()
let socket
let queue = Promise.resolve()
let epoch = 0
let queued = 0

// structuredClone preserves protobuf Long fields as {low, high}, without
// their numeric conversion methods. Keep expiry/size checks effective.
function numeric(value) {
  if (value && typeof value.low === 'number' && typeof value.high === 'number') {
    return (value.high >>> 0) * 2 ** 32 + (value.low >>> 0)
  }
  return Number(value)
}
function settings() {
  try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch {
    return { enabled: process.env.AUTO_SAVE_STATUS === 'true', deleted: false }
  }
}
function getEnabled(deleted = false) { return settings()[deleted ? 'deleted' : 'enabled'] === true }
function setEnabled(enabled, deleted = false) {
  const next = { ...settings(), [deleted ? 'deleted' : 'enabled']: Boolean(enabled) }
  fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(next))
  fs.renameSync(settingsFile + '.tmp', settingsFile)
  if (deleted && !enabled) {
    epoch++
    for (const id of records.keys()) remove(id)
  }
  return Boolean(enabled)
}
function file(id, extension) { return path.join(cacheDir, id + extension) }
function idFor(key) {
  return crypto.createHash('sha256').update(key.id + ':' + normalizedJid(key.participant)).digest('hex')
}
function remove(id) {
  for (const extension of ['.json', '.bin']) {
    try { fs.unlinkSync(file(id, extension)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  records.delete(id)
}
function prune(reserve = 0) {
  let size = 0
  for (const [id, record] of records) {
    if (Date.now() - record.at >= TTL) remove(id)
    else size += record.size
  }
  for (const [id, record] of records) {
    if (size + reserve <= MAX_CACHE && records.size < 200) break
    remove(id)
    size -= record.size
  }
}
function loadCache() {
  if (!fs.existsSync(cacheDir)) return
  for (const name of fs.readdirSync(cacheDir).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const id = name.slice(0, -5)
    try {
      const record = JSON.parse(fs.readFileSync(file(id, '.json'), 'utf8'))
      if (record.id !== id || !record.key?.id || !Number.isFinite(record.at)) throw Error('Invalid cache')
      record.size = fs.statSync(file(id, '.json')).size + (record.kind === 'text' ? 0 : fs.statSync(file(id, '.bin')).size)
      records.set(id, record)
    } catch { remove(id) }
  }
  // Reorder by arrival time so eviction always removes the oldest item.
  const ordered = [...records].sort((a, b) => a[1].at - b[1].at)
  records.clear()
  for (const [id, record] of ordered) records.set(id, record)
  for (const name of fs.readdirSync(cacheDir)) {
    if (/^[a-f0-9]{64}\.(?:bin|json\.tmp)$/.test(name) && !records.has(name.slice(0, 64))) fs.unlinkSync(path.join(cacheDir, name))
  }
  prune()
  if (!getEnabled(true)) for (const id of records.keys()) remove(id)
}
function persist(record, bytes) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const json = JSON.stringify(record)
  record.size = Buffer.byteLength(json) + (bytes?.length || 0)
  prune(record.size)
  if (bytes) fs.writeFileSync(file(record.id, '.bin'), bytes)
  try {
    fs.writeFileSync(file(record.id, '.json'), json)
    records.set(record.id, record)
  } catch (error) { remove(record.id); throw error }
}
async function contactName(raw, previous) {
  const jids = new Set([raw.key.participant, raw.key.participantAlt].map(normalizedJid).filter(Boolean))
  const sources = [knownContacts(socket), socket.contacts, socket.store?.contacts].map(source => {
    const entries = typeof source?.get === 'function' ? [...source.entries()] : Object.entries(source || {})
    return indexContacts(entries.map(([id, contact]) => ({ ...contact, id: contact?.id || id })))
  })
  function savedName() {
    for (const jid of jids) for (const source of sources) {
      const contact = source.get(jid)
      if (typeof contact?.name === 'string' && contact.name.trim()) return contact.name.trim()
      for (const value of [contact?.id, contact?.lid, contact?.phoneNumber, contact?.jid, contact?.pn]) {
        const alias = normalizedJid(value)
        if (alias) jids.add(alias)
      }
    }
    return ''
  }
  let name = savedName()
  if (!name) {
    const phone = await resolvePhone(socket, ...jids)
    if (phone) {
      jids.add(phone)
      try {
        const lid = normalizedJid(await socket.signalRepository?.lidMapping?.getLIDForPN?.(phone))
        if (lid) jids.add(lid)
      } catch {}
    }
    name = savedName()
  }
  // Preserve a known saved name across restarts, but never reuse a profile name
  // written by an older build. Recheck contacts at deletion time for renames.
  if (!name && previous?.savedName === true) name = previous.name
  if (name) return { name, savedName: true }
  const phone = [...jids].find(jid => jid.endsWith('@s.whatsapp.net'))
  return { name: phone?.split('@')[0] || [...jids][0] || 'Unknown contact', savedName: false }
}
async function deliver(record, bytes, deleted) {
  const destination = ownerJids(socket)[0]
  if (!destination) throw Error('No sudo destination')
  const title = (deleted ? 'Deleted status from ' : 'Status from ') + record.name
  if (record.kind === 'text') return socket.sendMessage(destination, { text: title + '\n\n' + record.text })
  const payload = { ...record.payload, [record.kind]: bytes }
  if (['image', 'video', 'document'].includes(record.kind)) payload.caption = title + (payload.caption ? '\n\n' + payload.caption : '')
  await socket.sendMessage(destination, payload)
  if (['audio', 'sticker'].includes(record.kind)) await socket.sendMessage(destination, { text: title })
}
async function receive(raw) {
  const key = raw?.key
  if (!key?.id || key.remoteJid !== 'status@broadcast' || key.fromMe) return
  const ownIds = [socket.user?.id, socket.user?.lid].map(normalizedJid).filter(Boolean)
  if (ownIds.includes(normalizedJid(key.participant))) return
  const content = normalizeMessageContent(raw.message)
  const protocol = content?.protocolMessage
  if (protocol?.type === 0 || protocol?.type === 'REVOKE') {
    return recover({ ...key, ...protocol.key, remoteJid: 'status@broadcast' })
  }
  if (!getEnabled() && !getEnabled(true)) return
  if (raw.messageTimestamp && Date.now() / 1000 - numeric(raw.messageTimestamp) >= 86400) return
  const found = inspectContent(content)
  if (!found) return
  const id = idFor(key)
  const live = getEnabled() && !sent.has(id)
  const caching = getEnabled(true) && !records.has(id)
  if (!live && !caching) return
  const started = epoch
  if (numeric(found.media?.fileLength || 0) > MAX_ITEM) return
  const bytes = found.kind === 'text' ? null : await download(socket, found, raw, MAX_ITEM)
  const payload = found.kind === 'text' ? undefined : mediaPayload(found, bytes)
  if (payload) delete payload[found.kind]
  const record = { id, key: { ...key }, at: Date.now(), ...await contactName(raw),
    kind: found.kind, text: found.text, payload }
  if (Buffer.byteLength(JSON.stringify(record)) > 128 * 1024) return
  if (caching && started === epoch && getEnabled(true)) persist(record, bytes)
  if (live && getEnabled()) {
    await deliver(record, bytes, false)
    sent.add(id)
    if (sent.size > 1000) sent.delete(sent.values().next().value)
  }
}
async function recover(key) {
  if (!getEnabled(true) || key?.remoteJid !== 'status@broadcast' || !key.id) return
  prune()
  const authors = [key.participant, key.participantAlt].map(normalizedJid).filter(Boolean)
  const matches = [...records.values()].filter(record => record.key.id === key.id &&
    (!authors.length || [record.key.participant, record.key.participantAlt].map(normalizedJid).some(jid => authors.includes(jid))))
  if (matches.length !== 1) return
  const record = matches[0]
  const bytes = record.kind === 'text' ? null : fs.readFileSync(file(record.id, '.bin'))
  await deliver({ ...record, ...await contactName({ key: record.key }, record) }, bytes, true)
  remove(record.id)
}
function enqueue(fn) {
  if (queued >= 200) {
    process.stderr.write('[status-save] Pending queue is full. Skipping this event to keep memory bounded.\n')
    return
  }
  queued++
  queue = queue.then(() => {
    if (global.saffulChatbotPaused !== true) return fn()
  }).catch(error => {
    process.stderr.write('[status-save] Operation failed: ' + String(error?.message || error).slice(0, 160) + '\n')
  }).finally(() => { queued-- })
}
function attach(target) {
  if (!target?.ev || attached.has(target)) return
  attached.add(target)
  socket = target
  attachContactCache(target)
  target.ev.on('messages.upsert', ({ messages = [] }) => {
    for (const raw of messages) if (raw?.key?.remoteJid === 'status@broadcast') {
      const copy = structuredClone(raw)
      enqueue(() => receive(copy))
    }
  })
  target.ev.on('messages.update', updates => {
    for (const { key, update } of updates || []) {
      if (key?.remoteJid !== 'status@broadcast') continue
      if (update?.messageStubType === 1 || update?.messageStubType === 'REVOKE') {
        enqueue(() => recover(key))
      } else if (update?.message) {
        const copy = structuredClone({ ...update, key })
        enqueue(() => receive(copy))
      }
    }
  })
  // Reuse Baileys' decryption mutex and offline queue for the new personal
  // status envelopes. Preserve tag=status so all ACKs retain their class.
  target.ws?.on?.('CB:status,from:status@broadcast', node => {
    if (!target.__saffulStatusAckFallback || (!getEnabled() && !getEnabled(true))) return
    if (node?.tag !== 'status' || node.attrs?.from !== 'status@broadcast' || !node.attrs?.participant) return
    if (Array.isArray(node.content) && node.content.some(child => child.tag === 'enc')) target.ws.emit('CB:message', node)
  })
}
loadCache()
const cleanup = setInterval(() => {
  try { prune() } catch {}
}, 60000)
cleanup.unref?.()
module.exports = { attach, getEnabled, setEnabled, receive, recover, idle: () => queue,
  cacheStats: () => ({ items: records.size, bytes: [...records.values()].reduce((sum, record) => sum + record.size, 0) }) }
