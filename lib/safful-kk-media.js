'use strict'

const { downloadContentFromMessage, proto } = require('@whiskeysockets/baileys')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { bufferFrom } = require('./safful-status-media')

const RESEND_TIMEOUT = Math.max(1000, Number(process.env.SAFFUL_KK_RESEND_MS) || 10000)
const RESEND_ATTEMPTS = 2

function delay(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

// Set SAFFUL_KK_DEBUG=1 to trace every recovery stage on stderr.
function debugLog(...parts) {
  if (!/^(1|true|yes|on)$/i.test(String(process.env.SAFFUL_KK_DEBUG || ''))) return
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
  try {
    if (typeof socket.requestPlaceholderResend === 'function') {
      const result = await deadline(Promise.resolve(socket.requestPlaceholderResend(messageKey)), 12000)
      debugLog('resend request', messageKey.id, 'result=' + String(result))
      return true
    }
    if (typeof socket.sendPeerDataOperationMessage === 'function') {
      const result = await deadline(Promise.resolve(socket.sendPeerDataOperationMessage({
        placeholderMessageResendRequest: [{ messageKey }],
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      })), 12000)
      debugLog('raw pdo request', messageKey.id, 'result=' + String(result))
      return true
    }
  } catch (error) {
    debugLog('resend request failed', messageKey.id, error?.message || String(error))
  }
  return false
}

// The phone answers a PDO resend as an ordinary upsert (Baileys tags the
// response with requestId). Watch every channel it can arrive on.
function watchAnswers(socket, onAnswer) {
  if (!socket?.ev?.on) return () => {}
  const upsert = data => { for (const raw of data?.messages || []) onAnswer(raw, data?.requestId) }
  const update = data => {
    for (const item of data || []) {
      if (!item?.update?.message) continue
      onAnswer({ ...item.update, key: { ...item.key, ...(item.update.key || {}) } }, item?.requestId)
    }
  }
  const history = data => { for (const raw of data?.messages || []) onAnswer(raw, data?.requestId) }
  try {
    socket.ev.on('messages.upsert', upsert)
    socket.ev.on('messages.update', update)
    socket.ev.on('messaging-history.set', history)
  } catch { return () => {} }
  return () => {
    for (const [event, handler] of [['messages.upsert', upsert],
      ['messages.update', update], ['messaging-history.set', history]]) {
      try { socket.ev.off?.(event, handler) } catch {}
    }
  }
}

// Ask the primary phone for the original message and collect its answer.
// Newer WhatsApp builds give linked devices no view-once ciphertext at all and
// strip the media key from the quote, so the phone is the only remaining
// source. The returned state says what really happened:
//   resent    - the phone returned the original (with a media key)
//   stub      - the phone answered, but without decryptable media
//   no-answer - the request went out and nothing came back in time
//   no-api    - this socket cannot request a resend at all
async function requestOriginal(socket, key, options = {}) {
  if (!socket || !key?.id || !key?.remoteJid) return { state: 'no-key', raw: null }
  const messageKey = pdoKey(key)
  const timeout = Math.max(1000, Number(options.timeout) || RESEND_TIMEOUT)
  const attempts = Math.max(1, Number(options.attempts) || RESEND_ATTEMPTS)
  const answers = []
  const stop = watchAnswers(socket, (raw, requestId) => {
    if (!raw || typeof raw !== 'object') return
    const ours = raw.key?.id === messageKey.id
    // A tagged answer during our wait is ours even when the phone restamped the
    // key; only untagged messages have to match the id exactly.
    if (!ours && !requestId) return
    const candidate = ours ? raw : { ...raw, key: { ...(raw.key || {}), ...messageKey } }
    const detected = detectViewOnce({ ...candidate, key: { ...candidate.key, isViewOnce: true } })
    answers.push({ raw: candidate, hasKey: hasMediaKey(detected?.media) })
    debugLog('resend answer', messageKey.id, 'tag=' + (requestId || 'none'),
      'media=' + Boolean(detected), 'key=' + hasMediaKey(detected?.media))
  })
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (!await sendResendRequest(socket, messageKey)) return { state: 'no-api', raw: null }
      const started = Date.now()
      while (Date.now() - started < timeout) {
        const withKey = answers.find(answer => answer.hasKey)
        if (withKey) return { state: 'resent', raw: withKey.raw }
        await delay(200)
      }
      debugLog('resend attempt', attempt, 'of', attempts, 'without media', messageKey.id)
    }
  } finally { stop() }
  const withKey = answers.find(answer => answer.hasKey)
  if (withKey) return { state: 'resent', raw: withKey.raw }
  if (answers.length) return { state: 'stub', raw: answers[answers.length - 1].raw }
  return { state: 'no-answer', raw: null }
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

module.exports = { asRaw, retrieve, statusCode, deadline, debugLog, hasMediaKey, mediaKey, normalizeMedia,
  recentOriginal, requestOriginal, sendResendRequest }
