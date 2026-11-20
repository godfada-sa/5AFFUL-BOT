'use strict'

const { cmd, commands } = require('../lib/plugins')
const { ownerJids } = require('../lib/safful-identities')
const { detectViewOnce } = require('../lib/safful-viewonce-detector')
const { rawQuotedPayload, quotedReference, mediaPayload } = require('../lib/safful-status-media')
const { asRaw, retrieve, statusCode, deadline, hasMediaKey, recentOriginal, requestOriginal } = require('../lib/safful-kk-media')
const active = new Set()

async function privateNotice(socket, destination, text) {
  try {
    if (!socket?.sendMessage || !destination) throw Error('No private destination')
    await socket.sendMessage(destination, { text: '[.kk] ' + text })
  } catch {
    // Never bubble into the legacy dispatcher, which can reply publicly.
    process.stderr.write('[kk] Could not deliver the private notification. Check the connection and SUDO setting.\n')
  }
}
function diagnostic(error) {
  if (error?.code === 'KK_MISSING_KEY') return 'Original media unavailable. Ask the sender to resend it normally.'
  if (error?.code === 'KK_MISSING_URL') return 'Media link unavailable. Ask the sender to resend it.'
  if (error?.code === 'KK_TIMEOUT') return 'Media request timed out. Try again.'
  if (error?.code === 'ERR_OSSL_BAD_DECRYPT') return 'Media decryption failed. Ask the sender to resend it.'
  const status = statusCode(error)
  if ([403, 404, 410].includes(status)) return 'Media unavailable (HTTP ' + status + '). Ask the sender to resend it.'
  return 'Media download failed' + (status ? ' (HTTP ' + status + ')' : '') + '. Try again.'
}
async function deliver(socket, destination, recovered) {
  try { await socket.sendMessage(destination, mediaPayload(recovered.found, recovered.bytes)) }
  catch (error) {
    await privateNotice(socket, destination, 'Could not send media to sudo' +
      (statusCode(error) ? ' (HTTP ' + statusCode(error) + ')' : '') + '. Check the number and connection.')
  }
}
function foundMedia(detected) {
  return { ...detected, kind: detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '') }
}
function foundFrom(raws, force) {
  return raws
    .map(raw => ({ raw, detected: detectViewOnce(force ? { ...raw, key: { ...raw.key, isViewOnce: true } } : raw) }))
    .filter(item => item.detected)
    .sort((a, b) => Number(hasMediaKey(b.detected.media)) - Number(hasMediaKey(a.detected.media)))
}
async function attempt(socket, items) {
  let recovered
  let lastError = Object.assign(Error('Missing original'), { code: 'KK_MISSING_KEY' })
  const tried = new Set()
  for (const candidate of items) {
    // Skip repeated references without discarding a different original key.
    const signature = JSON.stringify([candidate.detected.type, candidate.detected.media.directPath,
      candidate.detected.media.url, candidate.detected.media.mediaKey, candidate.raw.key])
    if (tried.has(signature)) continue
    if (tried.size >= 6) break
    tried.add(signature)
    try { recovered = await retrieve(socket, candidate.raw, candidate.detected); break }
    catch (error) { if (error.code !== 'KK_MISSING_KEY' || lastError.code === 'KK_MISSING_KEY') lastError = error }
  }
  return { recovered, lastError }
}
function worthResending(items, lastError) {
  if (!items.length || !items.some(item => hasMediaKey(item.detected.media))) return true
  if ([403, 404, 410].includes(statusCode(lastError))) return true
  return ['KK_MISSING_KEY', 'KK_MISSING_URL'].includes(lastError?.code)
}

async function unwrap(message, _text, meta = {}) {
  const socket = meta.Void || message.bot || global.__saffulLatestSocket
  const destination = ownerJids(socket)[0]
  let requestId
  try {
    if (!socket?.sendMessage || !destination) return privateNotice(socket, destination, 'Bot connection or sudo number unavailable.')
    const quoted = message.quoted
    const reference = quotedReference(message, meta)
    const key = { ...quoted?.key, id: reference.id,
      remoteJid: quoted?.key?.remoteJid || message.chat || message.key?.remoteJid || reference.chat,
      participant: quoted?.key?.participant || quoted?.sender || reference.participant }
    if (!key.id) return privateNotice(socket, destination, 'Reply to a view-once photo, video or voice note with .kk.')
    requestId = key.remoteJid + ':' + key.id
    if (active.has(requestId) || active.size >= 2) {
      requestId = undefined
      return privateNotice(socket, destination, 'Media recovery in progress. Please wait.')
    }
    active.add(requestId)
    let cache
    try { cache = await require('../lib/safful-protection').readCapturedViewOnce(key.remoteJid, key.id) } catch {}
    if (cache?.bytes) return await deliver(socket, destination, { bytes: cache.bytes, found: foundMedia(detectViewOnce(cache.raw)) })
    const candidates = [cache?.raw, quoted?.fakeObj, quoted, rawQuotedPayload(message, meta)]
    // Baileys keeps recently decrypted content for retry receipts; use it
    // before touching the store or asking the phone for a resend.
    const recent = recentOriginal(socket, key.remoteJid, key.id)
    if (recent) candidates.push(recent)
    for (const store of [...new Set([meta.store, socket.store].filter(Boolean))]) {
      for (const method of ['loadMessage', 'getMessages']) {
        try {
          if (typeof store[method] === 'function') {
            const original = await deadline(Promise.resolve(store[method](key.remoteJid, key.id)), 3000)
            candidates.push(Array.isArray(original) ? original.find(raw => raw?.key?.id === key.id) : original)
          }
        } catch {}
      }
      const entries = store.messages?.[key.remoteJid]
      candidates.push((Array.isArray(entries) ? entries : entries?.array || []).find(raw => raw?.key?.id === key.id))
    }
    for (const holder of [quoted, message]) {
      try { if (typeof holder?.getQuotedObj === 'function') candidates.push(await deadline(Promise.resolve(holder.getQuotedObj()), 3000)) } catch {}
    }
    const rawCandidates = candidates.filter(Boolean).map(raw => asRaw(raw, key)).filter(raw => raw.key?.id === key.id)
    // A serializer can strip the wrapper from a stored original. Once this
    // exact reply is confirmed as view-once, that original remains usable.
    let found = foundFrom(rawCandidates, rawCandidates.some(raw => detectViewOnce(raw)))
    let { recovered, lastError } = await attempt(socket, found)
    if (!recovered && worthResending(found, lastError)) {
      // New WhatsApp builds send linked devices only an "unavailable"
      // view-once stub and strip media fields from a quote. Ask the primary
      // phone to resend the original stanza, then retry with the full message.
      const resent = await requestOriginal(socket, key)
      if (resent) {
        found = foundFrom([asRaw(resent, key)], true)
        ;({ recovered, lastError } = await attempt(socket, found))
      }
    }
    if (!recovered) {
      return privateNotice(socket, destination, found.length
        ? diagnostic(lastError) : 'No view-once media found. Reply to an available view-once message.')
    }
    await deliver(socket, destination, recovered)
  } catch (error) {
    await privateNotice(socket, destination, diagnostic(error))
  } finally { if (requestId) active.delete(requestId) }
}

const command = cmd({ pattern: 'kk', alias: ['unwrap', 'readvo'], desc: 'Send replied view-once media to sudo', category: 'owner',
  filename: __filename, use: '<reply to view-once media>' }, unwrap)
setImmediate(() => {
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i] !== command && commands[i].pattern === 'kk') commands.splice(i, 1)
  }
})
module.exports = { unwrap }
