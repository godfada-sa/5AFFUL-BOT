'use strict'

const { cmd } = require('../lib/plugins')
const { isOperator, ownerJids } = require('../lib/safful-identities')

const { inspectContent, quotedReference, rawQuotedPayload, originalFromStore, bufferFrom, mediaPayload, download } = require('../lib/safful-status-media')

async function save(message, _text, meta = {}) {
  const socket = meta.Void || message.bot
  if (!await isOperator(message, meta, socket)) return message.reply('Owner only.')
  const destination = ownerJids(socket)[0]
  if (!destination || !socket?.sendMessage) return message.reply('Bot connection or sudo number unavailable.')
  const reference = quotedReference(message, meta)
  const quoted = message.quoted
  let original = await originalFromStore(meta.store, reference)
  if (!original && typeof quoted?.getQuotedObj === 'function') {
    try { original = await quoted.getQuotedObj() } catch {}
  }
  if (!original && typeof message.getQuotedObj === 'function') {
    try { original = await message.getQuotedObj() } catch {}
  }
  const candidates = [original?.message, original, quoted?.message,
    quoted?.fakeObj?.message, quoted?.quotedMessage, quoted, rawQuotedPayload(message, meta)]
  let fallbackText = ''
  let found = null
  for (const candidate of candidates) {
    const result = inspectContent(candidate)
    if (result?.kind === 'text' && !fallbackText) fallbackText = result.text
    if (result && result.kind !== 'text') { found = result; break }
  }
  if (!found) {
    // An extended-text quote alone can be just a media caption stripped by
    // WhatsApp. Only treat it as a text status when the original or a plain
    // conversation payload confirms that it was text-only.
    if (fallbackText && (original || quoted?.message?.conversation || quoted?.quotedMessage?.conversation)) {
      return socket.sendMessage(destination, { text: fallbackText })
    }
    return message.reply('No status media found. Reply to a status.')
  }
  try {
    const bytes = await download(socket, found, original)
    await socket.sendMessage(destination, mediaPayload(found, bytes))
  } catch (error) {
    console.error('[save] media download failed:', error)
    return message.reply('Status download failed. Try again.')
  }
}

cmd({ pattern: 'save', alias: ['dlstatus', 'statusdl', 'swdl'], desc: 'Save replied status media or text to sudo', category: 'downloader', filename: __filename }, save)
module.exports = { save, inspectContent, quotedReference, rawQuotedPayload, originalFromStore, bufferFrom, mediaPayload }
