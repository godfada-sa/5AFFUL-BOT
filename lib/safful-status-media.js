'use strict'

const { downloadContentFromMessage } = require('@whiskeysockets/baileys')

const MEDIA = {
  imageMessage: 'image', videoMessage: 'video', ptvMessage: 'video',
  audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker',
}
const MAX_BYTES = 64 * 1024 * 1024

function inspectContent(root) {
  const seen = new Set()
  let text = ''
  function visit(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node) || Buffer.isBuffer(node)) return null
    seen.add(node)
    for (const [key, kind] of Object.entries(MEDIA)) {
      if (node[key] && typeof node[key] === 'object') return { kind, media: node[key], type: key }
    }
    if (!text) text = typeof node.conversation === 'string' ? node.conversation :
      typeof node.extendedTextMessage?.text === 'string' ? node.extendedTextMessage.text : ''
    // Prefer the actual quoted payload over captions and context metadata.
    for (const key of ['quotedMessage', 'message', 'ephemeralMessage', 'viewOnceMessage',
      'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
      'editedMessage', 'associatedChildMessage', 'fakeObj', 'raw']) {
      const result = visit(node[key], depth + 1)
      if (result) return result
    }
    for (const value of Object.values(node)) {
      const result = visit(value, depth + 1)
      if (result) return result
    }
    return null
  }
  const media = visit(root)
  return media || (text ? { kind: 'text', text } : null)
}

function quotedReference(message, meta) {
  const raw = meta?.mek?.message || message?.fakeObj?.message || message?.message
  const queue = [raw]
  const seen = new Set()
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object' || seen.has(node) || Buffer.isBuffer(node)) continue
    seen.add(node)
    if (node.contextInfo?.stanzaId) {
      const context = node.contextInfo
      return { id: context.stanzaId, chat: context.remoteJid || contextInfoChat(context), participant: context.participant }
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push(value)
  }
  return { id: message?.quoted?.id || message?.quoted?.key?.id || '', chat: 'status@broadcast' }
}

function rawQuotedPayload(message, meta) {
  const root = meta?.mek?.message || message?.fakeObj?.message || message?.message
  const queue = [root], seen = new Set()
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object' || seen.has(node) || Buffer.isBuffer(node)) continue
    seen.add(node)
    if (node.contextInfo?.quotedMessage) return node.contextInfo.quotedMessage
    for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push(value)
  }
  return null
}

function contextInfoChat(context) {
  return context.quotedMessage ? 'status@broadcast' : ''
}

async function originalFromStore(store, reference) {
  if (!reference.id || !store) return null
  for (const jid of [...new Set([reference.chat, 'status@broadcast'].filter(Boolean))]) {
    try {
      const item = await (store.loadMessage?.(jid, reference.id) || store.getMessages?.(jid, reference.id))
      if (item) return item
    } catch {}
    const entries = store.messages?.[jid]
    const list = Array.isArray(entries) ? entries : entries?.array || []
    const found = list.find(item => item?.key?.id === reference.id)
    if (found) return found
  }
  return null
}

async function bufferFrom(stream, maxBytes = MAX_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Status media exceeds download limit')
    chunks.push(Buffer.from(chunk))
  }
  if (!size) throw new Error('WhatsApp returned empty media')
  return Buffer.concat(chunks)
}

async function download(socket, found, original, maxBytes = MAX_BYTES) {
  const fetch = async media => bufferFrom(await downloadContentFromMessage(media, found.kind, { options: { timeout: 30000 } }), maxBytes)
  try { return await fetch(found.media) }
  catch (error) {
    const status = error.status || error.response?.status || error.output?.statusCode
    if (![404, 410].includes(status) || typeof socket.updateMediaMessage !== 'function') throw error
    const message = original?.key ? original : { key: original?.key || {}, message: { [found.type]: found.media } }
    const updated = await socket.updateMediaMessage(message)
    const refreshed = inspectContent(updated?.message || updated)
    if (!refreshed || refreshed.kind !== found.kind) throw error
    return fetch(refreshed.media)
  }
}

function mediaPayload(found, buffer) {
  const media = found.media
  if (found.kind === 'audio') return { audio: buffer, mimetype: media.mimetype || 'audio/ogg; codecs=opus', ptt: Boolean(media.ptt) }
  if (found.kind === 'document') return { document: buffer, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || 'status-file' }
  if (found.kind === 'sticker') return { sticker: buffer }
  return { [found.kind]: buffer, mimetype: media.mimetype || (found.kind === 'video' ? 'video/mp4' : 'image/jpeg'), caption: media.caption || '' }
}

module.exports = { inspectContent, quotedReference, rawQuotedPayload, originalFromStore, bufferFrom, mediaPayload, download }
