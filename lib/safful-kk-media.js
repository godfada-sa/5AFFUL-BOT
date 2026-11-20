'use strict'

const { downloadContentFromMessage, proto } = require('@whiskeysockets/baileys')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { bufferFrom } = require('./safful-status-media')

const RESEND_TIMEOUT = 15000

function mediaKey(value) {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Buffer.from(value)
  if (value?.type === 'Buffer') return mediaKey(value.data)
  if (typeof value === 'string') return Buffer.from(value.replace(/^data:;base64,/, ''), 'base64')
  return null
}
function hasMediaKey(media) {
  const key = mediaKey(media?.mediaKey)
  return Boolean(key && key.length === 32)
}
function statusCode(error) {
  return Number(error?.status || error?.response?.status || error?.output?.statusCode) || 0
}
function deadline(task, ms, onTimeout = () => {}) {
  let timer
  return Promise.race([task, new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(Object.assign(Error('Media operation timed out'), { code: 'KK_TIMEOUT' }))
    }, ms)
  })]).finally(() => clearTimeout(timer))
}
function asRaw(candidate, key) {
  if (!candidate || typeof candidate !== 'object') return null
  if (candidate.message) return { ...candidate, key: { ...key, ...candidate.key } }
  if (candidate.mtype && candidate.msg) return { key: { ...key, ...candidate.key }, message: { [candidate.mtype]: candidate.msg } }
  return { key, message: candidate }
}

// WhatsApp may now send a full https url without a directPath, while Baileys
// only trusts a "host/path" url and otherwise rebuilds the CDN address from
// directPath. Normalise both shapes so the download never fails on metadata.
function normalizeMedia(media) {
  const url = typeof media?.url === 'string' ? media.url.trim() : ''
  let directPath = typeof media?.directPath === 'string' ? media.directPath : ''
  if (!directPath && url) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url)
      directPath = parsed.pathname + parsed.search
    } catch {}
  }
  let normalizedUrl = url.replace(/^https?:\/\//i, '')
  if (!normalizedUrl.startsWith('mmg.whatsapp.net/')) normalizedUrl = ''
  return { ...media, directPath, url: normalizedUrl || undefined }
}

// Baileys keeps recently decrypted message content for retry receipts; it is
// the cheapest source of an original media key when the quote was stripped.
function recentOriginal(socket, chat, id) {
  try {
    const recent = socket?.messageRetryManager?.getRecentMessage?.(chat, id)
    if (recent?.message) return { key: { remoteJid: chat, id }, message: recent.message }
  } catch {}
  return null
}

// New WhatsApp clients no longer fan view-once ciphertext out to linked
// devices (the companion only sees an "unavailable" stub) and strip media
// fields from a quote. Ask the primary phone to resend the original stanza,
// then use the full message it returns.
function pdoKey(key) {
  return {
    remoteJid: key.remoteJid, fromMe: Boolean(key.fromMe), id: key.id,
    participant: key.participant || undefined,
  }
}

// Fire-and-forget variant for the capture pipeline: the phone's answer arrives
// as a normal messages.upsert, which the view-once detector already handles.
async function sendResendRequest(socket, key) {
  if (!socket || !key?.id || !key?.remoteJid) return false
  const messageKey = pdoKey(key)
  try {
    if (typeof socket.requestPlaceholderResend === 'function') {
      await deadline(Promise.resolve(socket.requestPlaceholderResend(messageKey)), 9000)
      return true
    }
    if (typeof socket.sendPeerDataOperationMessage === 'function') {
      await deadline(Promise.resolve(socket.sendPeerDataOperationMessage({
        placeholderMessageResendRequest: [{ messageKey }],
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      })), 9000)
      return true
    }
  } catch {}
  return false
}

async function requestOriginal(socket, key, timeout = RESEND_TIMEOUT) {
  if (!socket || !key?.id || !key?.remoteJid) return null
  const messageKey = pdoKey(key)
  let settle
  const arrival = new Promise(resolve => { settle = resolve })
  const onUpsert = data => {
    for (const raw of data?.messages || []) {
      if (raw?.key?.id === messageKey.id) settle(raw)
    }
  }
  const cleanup = () => { try { socket.ev?.off?.('messages.upsert', onUpsert) } catch {} }
  try { socket.ev?.on?.('messages.upsert', onUpsert) } catch {}
  try {
    if (typeof socket.requestPlaceholderResend === 'function') {
      // Baileys own PDO helper: deduplicates in-flight requests and caches the
      // response metadata for the upsert it emits.
      await deadline(Promise.resolve(socket.requestPlaceholderResend(messageKey)), 9000)
    } else if (typeof socket.sendPeerDataOperationMessage === 'function') {
      await deadline(Promise.resolve(socket.sendPeerDataOperationMessage({
        placeholderMessageResendRequest: [{ messageKey }],
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      })), 9000)
    } else {
      cleanup()
      return null
    }
  } catch {
    // The phone may still answer (or a request may already be in flight).
  }
  try {
    return await deadline(arrival, timeout)
  } catch { return null } finally { cleanup() }
}

async function retrieve(socket, raw, detected) {
  const kind = detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '')
  const key = mediaKey(detected.media.mediaKey)
  if (!key || key.length !== 32) throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  const found = { ...detected, kind, media: { ...normalizeMedia(detected.media), mediaKey: key } }
  async function fetch(media) {
    let stream, expired = false
    const task = (async () => {
      stream = await downloadContentFromMessage(media, kind)
      if (expired) { stream.destroy?.(); throw Error('Download expired') }
      return bufferFrom(stream)
    })()
    return deadline(task, 20000, () => { expired = true; stream?.destroy?.() })
  }
  let failure
  if (found.media.directPath || found.media.url) {
    try { return { found, bytes: await fetch(found.media) } } catch (error) { failure = error }
    if (![400, 403, 404, 410].includes(statusCode(failure))) throw failure
  }
  if (!raw.key?.id || !raw.key?.remoteJid || typeof socket.updateMediaMessage !== 'function') {
    throw failure || Object.assign(Error('No original download location'), { code: 'KK_MISSING_URL' })
  }
  // The refresh API accepts unwrapped media and unwraps view-once wrappers
  // itself. Its assertion does not accept ptvMessage, so video notes use
  // videoMessage while retaining the original key.
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const request = { key: { ...raw.key }, message: { [type]: { ...found.media } } }
  const updated = await deadline(Promise.resolve(socket.updateMediaMessage(request)), 15000)
  const refreshed = detectViewOnce({ ...(updated || request), key: { ...(updated || request).key, isViewOnce: true } })
  if (!refreshed) throw Object.assign(Error('No refreshed media'), { code: 'KK_MISSING_URL' })
  found.media = { ...normalizeMedia(refreshed.media), mediaKey: mediaKey(refreshed.media.mediaKey) || key }
  return { found, bytes: await fetch(found.media) }
}

module.exports = { asRaw, retrieve, statusCode, deadline, hasMediaKey, mediaKey, normalizeMedia, recentOriginal, requestOriginal, sendResendRequest }
