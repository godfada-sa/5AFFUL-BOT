'use strict'

const { cmd, commands } = require('../lib/plugins')
const { ownerJids } = require('../lib/safful-identities')
const { detectViewOnce } = require('../lib/safful-viewonce-detector')
const { rawQuotedPayload, quotedReference, mediaPayload } = require('../lib/safful-status-media')
const capture = require('../lib/safful-kk-capture')
const { asRaw, retrieve, relayStored, statusCode, deadline, logLine, hasMediaKey, recentOriginal } = require('../lib/safful-kk-media')
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
  if (error?.code === 'KK_NOT_DELIVERED') {
    return 'This device never received the view-once media. WhatsApp sent only an unavailable notice, so there is nothing to decrypt locally. Ask the sender to resend it as a normal photo or video.'
  }
  if (error?.code === 'KK_MISSING_KEY') {
    return 'Original media unavailable. This device never received the view-once payload, so there is nothing stored to relay. Turn on .antiviewonce in this chat before it is opened, or ask the sender to resend it normally.'
  }
  if (error?.code === 'KK_MISSING_URL') return 'Media link unavailable. Ask the sender to resend it.'
  if (error?.code === 'KK_TIMEOUT') return 'Media request timed out. Try again.'
  if (error?.code === 'KK_NO_RELAY') return 'This connection cannot relay the stored original. Ask the sender to resend it normally.'
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
function capturedMedia(entry) {
  return { type: entry.type, kind: entry.kind, media: entry.media || {} }
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
    catch (error) {
      logLine('kk-attempt-failed', candidate.detected.type, error?.code || statusCode(error) || error?.message)
      if (error.code !== 'KK_MISSING_KEY' || lastError.code === 'KK_MISSING_KEY') lastError = error
    }
  }
  return { recovered, lastError }
}
// Prefer the original that can be relayed without a local download: it needs a
// media key and a CDN location, and a directPath beats a plain url.
function relayCandidates(items) {
  return items
    .filter(item => hasMediaKey(item.detected.media))
    .sort((a, b) => Number(Boolean(b.detected.media.directPath || b.detected.media.url)) -
      Number(Boolean(a.detected.media.directPath || a.detected.media.url)))
    .slice(0, 3)
}

async function unwrap(message, text, meta = {}) {
  const socket = meta.Void || message.bot || global.__saffulLatestSocket
  const destination = ownerJids(socket)[0]
  let requestId
  try {
    if (!socket?.sendMessage || !destination) return privateNotice(socket, destination, 'Bot connection or sudo number unavailable.')
    if (/^(status|stats)$/i.test(String(text || '').trim())) {
      const state = capture.status()
      return privateNotice(socket, destination,
        `Capture ${state.enabled ? 'ON' : 'OFF'} | stored ${state.entries} | decrypted ${state.captured} | ${Math.round(state.bytes / 1024)} KB | pending ${state.pending}`)
    }
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
    // The arrival cache is the only source that survives a stripped quote, a
    // trimmed store and the CDN deletion that follows "view once".
    const captured = await capture.read(key.remoteJid, key.id).catch(() => null)
    logLine('kk-start', requestId, 'capture=' + (captured
      ? (captured.bytes ? 'bytes(' + captured.bytes.length + ')' : 'raw:' + (captured.reason || 'no-bytes'))
      : 'none'))
    let cache
    try { cache = await require('../lib/safful-protection').readCapturedViewOnce(key.remoteJid, key.id) } catch {}
    const candidates = [captured?.raw, cache?.raw, quoted?.fakeObj, quoted, rawQuotedPayload(message, meta)]
    // Baileys keeps recently decrypted content for retry receipts; use it
    // before touching the store.
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
    logLine('kk-candidates', rawCandidates.length, 'view-once', found.length,
      'with-key', found.filter(item => hasMediaKey(item.detected.media)).length)
    // 1. Relay the stored original as an ordinary message. Nothing is
    // downloaded and no media key is needed on this device: the recipient
    // fetches the CDN ciphertext with the key that is already inside the stored
    // stanza. This is the levanter .vv approach, and it is the only path that
    // survives a quote whose media fields WhatsApp has stripped.
    for (const candidate of relayCandidates(found)) {
      try {
        await relayStored(socket, destination, candidate.detected)
        logLine('kk-relayed', requestId, candidate.detected.type)
        return
      } catch (error) {
        logLine('kk-relay-failed', requestId, error?.code || statusCode(error) || error?.message)
      }
    }
    // 2. Media captured when the view-once arrived. Once WhatsApp has taken the
    // original away this cache is the only surviving copy.
    if (captured?.bytes && captured.entry?.type) {
      return await deliver(socket, destination, { bytes: captured.bytes, found: capturedMedia(captured.entry) })
    }
    if (cache?.bytes) return await deliver(socket, destination, { bytes: cache.bytes, found: foundMedia(detectViewOnce(cache.raw)) })
    // 3. Last resort: decrypt the stored original in place.
    let { recovered, lastError } = await attempt(socket, found)
    if (!recovered) {
      logLine('kk-failed', requestId, lastError?.code || statusCode(lastError) || lastError?.message)
      const unavailable = Boolean(captured && !captured.bytes && /^unavailable:/.test(captured.reason || ''))
      if (unavailable) lastError = Object.assign(Error('Not delivered to this device'), { code: 'KK_NOT_DELIVERED' })
      return privateNotice(socket, destination, unavailable || found.length
        ? diagnostic(lastError) : 'No view-once media found. Reply to an available view-once message.')
    }
    logLine('kk-delivered', requestId, recovered.bytes?.length + 'B')
    await deliver(socket, destination, recovered)
  } catch (error) {
    logLine('kk-error', error?.code || statusCode(error) || error?.message)
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
