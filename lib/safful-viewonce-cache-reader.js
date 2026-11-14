'use strict'

const fs = require('fs')
const { detectViewOnce } = require('./safful-viewonce-detector')

// Reuse the existing anti-delete capture; do not create another media cache.
module.exports = function createReader({ lookup, clone, limit }) {
  return async function readCapturedViewOnce(chat, id) {
    if (!chat || !id) return null
    const entry = lookup(chat, id)
    const key = entry?.message?.key
    const normalize = value => String(value || '').replace(/:\d+@/, '@')
    // The old lookup has an ID-only fallback. Verify the chat before using it.
    if (key?.id !== id || ![key.remoteJid, key.remoteJidAlt].some(jid => normalize(jid) === normalize(chat))) return null
    const raw = clone(entry.message)
    if (!detectViewOnce(raw)) return null
    let timer
    const captured = entry.capturedViewOnce || await Promise.race([
      Promise.resolve(entry.viewOnceCapture).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000) }),
    ]).finally(() => clearTimeout(timer))
    if (!captured?.filePath) return { raw }
    try {
      const stat = await fs.promises.stat(captured.filePath)
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) return { raw }
      const bytes = await fs.promises.readFile(captured.filePath)
      if (bytes.length > limit) return { raw }
      return { raw, bytes }
    } catch { return { raw } }
  }
}
