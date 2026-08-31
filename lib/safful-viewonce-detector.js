'use strict'

const { viewOnceMedia } = require('./safful-protection')

const WRAPPERS = new Set([
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
])
const MEDIA = new Set(['imageMessage', 'videoMessage', 'audioMessage'])

function detectViewOnce(raw) {
  const protectedMatch = viewOnceMedia(raw)
  if (protectedMatch) return protectedMatch

  const seen = new WeakSet()
  const visit = (value, inViewOnce = false) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    for (const [type, media] of Object.entries(value)) {
      if (WRAPPERS.has(type) && media?.message) {
        const found = visit(media.message, true)
        if (found) return found
      }
      if (type === 'ephemeralMessage' && media?.message) {
        const found = visit(media.message, inViewOnce)
        if (found) return found
      }
      if (MEDIA.has(type) && media && (inViewOnce || media.viewOnce)) return { type, media }
    }
    return null
  }

  return visit(raw?.message || raw)
}

function attach(socket, onViewOnce) {
  if (!socket?.ev?.on || socket.__saffulViewOnceDetectorAttached) return
  socket.__saffulViewOnceDetectorAttached = true
  const dispatch = async raw => {
    const detected = detectViewOnce(raw)
    if (detected) await onViewOnce(raw, detected)
  }

  // The raw dispatcher is registered before normal command handling, so media
  // is captured while WhatsApp's encrypted-media URL is still usable.
  if (socket.__saffulRawDispatcher?.onUpsert) {
    socket.__saffulRawDispatcher.onUpsert(({ messages = [] } = {}) => {
      for (const message of messages) void dispatch(message).catch(error => {
        process.stdout.write(`[antiviewonce] Detector error: ${error?.message || error}\n`)
      })
    })
    return
  }

  socket.ev.on('messages.upsert', ({ messages = [] } = {}) => {
    for (const message of messages) void dispatch(message).catch(error => {
      process.stdout.write(`[antiviewonce] Detector error: ${error?.message || error}\n`)
    })
  })
}

module.exports = { attach, detectViewOnce }
