'use strict'

const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { bufferFrom } = require('./safful-status-media')

function mediaKey(value) {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Buffer.from(value)
  if (value?.type === 'Buffer') return mediaKey(value.data)
  if (typeof value === 'string') return Buffer.from(value.replace(/^data:;base64,/, ''), 'base64')
  return null
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

async function retrieve(socket, raw, detected) {
  const kind = detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '')
  const key = mediaKey(detected.media.mediaKey)
  if (!key || key.length !== 32) throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  const found = { ...detected, kind, media: { ...detected.media, mediaKey: key } }
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
    if (![403, 404, 410].includes(statusCode(failure))) throw failure
  }
  if (!raw.key?.id || !raw.key?.remoteJid || typeof socket.updateMediaMessage !== 'function') {
    throw failure || Object.assign(Error('No original download location'), { code: 'KK_MISSING_URL' })
  }
  // The refresh API accepts unwrapped media. Its assertion does not accept
  // ptvMessage, so video notes use videoMessage while retaining the original key.
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const request = { key: { ...raw.key }, message: { [type]: { ...found.media } } }
  const updated = await deadline(Promise.resolve(socket.updateMediaMessage(request)), 15000)
  const refreshed = detectViewOnce({ ...(updated || request), key: { ...(updated || request).key, isViewOnce: true } })
  if (!refreshed) throw Object.assign(Error('No refreshed media'), { code: 'KK_MISSING_URL' })
  found.media = { ...refreshed.media, mediaKey: mediaKey(refreshed.media.mediaKey) || key }
  return { found, bytes: await fetch(found.media) }
}

module.exports = { asRaw, retrieve, statusCode, deadline }
