'use strict'

const fs = require('fs')
const path = require('path')
const { downloadContentFromMessage, generateMessageIDV2, proto } = require('@whiskeysockets/baileys')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { bufferFrom } = require('./safful-status-media')

const LOG_FILE = process.env.SAFFUL_KK_LOG || path.join(__dirname, '..', 'temp', 'kk.log')
const MAX_LOG_BYTES = 2 * 1024 * 1024

// Always keep a small on-disk trace. The bot is normally started by a panel,
// so asking the user to relaunch with an env var loses the evidence. This file
// is the only reliable way to see what the phone actually answered.
function logLine(...parts) {
  try {
    const line = new Date().toISOString() + ' ' + parts.map(part => typeof part === 'string'
      ? part
      : JSON.stringify(part, (_key, value) => (Buffer.isBuffer(value) ? '<' + value.length + 'B>' : value))).join(' ') + '\n'
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try { if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1') } catch {}
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

// Set SAFFUL_KK_DEBUG=1 to keep the console noisy as well.
function debugLog(...parts) {
  if (!/^(1|true|yes|on)$/i.test(String(process.env.SAFFUL_KK_DEBUG || ''))) return
  logLine(...parts)
  try {
    process.stderr.write('[kk] ' + parts.map(part => typeof part === 'string'
      ? part
      : JSON.stringify(part, (_key, value) => (Buffer.isBuffer(value) ? '<' + value.length + 'B>' : value))).join(' ') + '\n')
  } catch {}
}

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

// Baileys deduplicates resend requests through its placeholder cache: a second
// request for the same id returns immediately and sends nothing at all. That
// made .kk silently skip the phone whenever Baileys had already queued a
// request for the same unavailable stub. Always clear the entry first.
async function clearResendCache(socket, id) {
  const cache = socket?.placeholderResendCache
  if (!id || !cache || typeof cache.del !== 'function') return
  try { await Promise.resolve(cache.del(id)) } catch {}
}

// Fire-and-forget variant for the capture pipeline: the phone's answer arrives
// as a normal messages.upsert, which the view-once detector already handles.
async function sendResendRequest(socket, key) {
  if (!socket || !key?.id || !key?.remoteJid) return false
  const messageKey = pdoKey(key)
  await clearResendCache(socket, messageKey.id)
  if (typeof socket.requestPlaceholderResend === 'function') {
    try {
      const result = await deadline(Promise.resolve(socket.requestPlaceholderResend(messageKey)), 12000)
      // `undefined` means Baileys thinks a request is already in flight. Keep
      // waiting for that answer instead of sending a duplicate request.
      logLine('resend-helper', messageKey.id, 'result=' + String(result))
      return true
    } catch (error) {
      logLine('resend-helper-failed', messageKey.id, error?.message || String(error))
    }
  }
  if (typeof socket.sendPeerDataOperationMessage === 'function') {
    try {
      const result = await deadline(Promise.resolve(socket.sendPeerDataOperationMessage({
        placeholderMessageResendRequest: [{ messageKey }],
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      })), 12000)
      logLine('resend-raw-pdo', messageKey.id, 'result=' + String(result))
      return true
    } catch (error) {
      logLine('resend-raw-pdo-failed', messageKey.id, error?.message || String(error))
    }
  }
  return false
}

// Re-send the stored original as an ordinary message instead of downloading it.
// The relay carries the mediaKey/url/directPath that are already in the stored
// stanza, so no key handling and no local download are involved: the recipient
// fetches the ciphertext straight from the CDN. This is how other Baileys bots
// (levanter's .vv plugin, via forwardOrBroadCast(..., { viewOnce: false }))
// deliver view-once media, and it is the only path that survives a stripped
// quote, because it never asks this device to decrypt anything.
function relayContent(detected) {
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const media = { ...detected.media }
  delete media.viewOnce
  delete media.ptv
  media.mediaKey = mediaKey(media.mediaKey)
  return { [type]: media }
}

async function relayStored(socket, destination, detected) {
  if (!detected?.type || !detected?.media) {
    throw Object.assign(Error('No stored original media'), { code: 'KK_MISSING_KEY' })
  }
  const key = mediaKey(detected.media.mediaKey)
  if (!key || key.length !== 32) throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  if (!detected.media.directPath && !detected.media.url) {
    throw Object.assign(Error('No original download location'), { code: 'KK_MISSING_URL' })
  }
  if (typeof socket?.relayMessage !== 'function') {
    throw Object.assign(Error('This socket cannot relay a stored message'), { code: 'KK_NO_RELAY' })
  }
  const content = relayContent(detected)
  const messageId = typeof socket.generateMessageIDV2 === 'function'
    ? socket.generateMessageIDV2() : generateMessageIDV2()
  await deadline(Promise.resolve(socket.relayMessage(destination, content, { messageId })), 20000)
  logLine('relayed', destination, Object.keys(content)[0])
  return Object.keys(content)[0]
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

// Compact description used by the log file, never sent to a chat.
function describe(raw) {
  const detected = detectViewOnce(raw)
  if (!detected) return { viewOnce: false }
  const media = detected.media || {}
  return {
    viewOnce: true,
    type: detected.type,
    key: hasMediaKey(media),
    directPath: typeof media.directPath === 'string' && media.directPath.length > 0,
    url: typeof media.url === 'string' && media.url.length > 0,
    caption: Boolean(media.caption),
  }
}

module.exports = { asRaw, retrieve, relayStored, relayContent, statusCode, deadline, debugLog, logLine, describe,
  hasMediaKey, mediaKey, normalizeMedia, recentOriginal, sendResendRequest }
