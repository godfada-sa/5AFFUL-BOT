'use strict'

const { cmd, commands } = require('../lib/plugins')
const { ownerJids } = require('../lib/safful-identities')
const { detectViewOnce } = require('../lib/safful-viewonce-detector')
const { rawQuotedPayload, quotedReference, originalFromStore, download, mediaPayload } = require('../lib/safful-status-media')

async function unwrap(message, _text, meta = {}) {
  const socket = meta.Void || message.bot
  const destination = ownerJids(socket)[0]
  if (!socket?.sendMessage || !destination) return message.reply('No sudo destination or bot connection is available.')
  const quoted = message.quoted
  const reference = quotedReference(message, meta)
  reference.chat = quoted?.key?.remoteJid || message.chat || message.key?.remoteJid || reference.chat
  let original = await originalFromStore(meta.store || socket.store, reference)
  if (!original && typeof quoted?.getQuotedObj === 'function') {
    try { original = await quoted.getQuotedObj() } catch {}
  }
  if (!original && typeof message.getQuotedObj === 'function') {
    try { original = await message.getQuotedObj() } catch {}
  }
  const candidates = [original, quoted?.fakeObj, quoted, rawQuotedPayload(message, meta)]
  for (const candidate of candidates) {
    const detected = detectViewOnce(candidate)
    if (!detected) continue
    const kind = detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '')
    const raw = original || { key: { ...quoted?.key, id: reference.id, remoteJid: reference.chat,
      participant: quoted?.sender || quoted?.key?.participant || reference.participant }, message: { [detected.type]: detected.media } }
    try {
      const found = { ...detected, kind }
      const bytes = await download(socket, found, raw)
      await socket.sendMessage(destination, mediaPayload(found, bytes))
    } catch {
      await message.reply('Could not retrieve this view-once media. WhatsApp may have supplied only an unavailable notice, or the media has expired.')
    }
    return
  }
  return message.reply('Reply to a view-once photo, video or voice note with .kk. Its original media must be available to this device.')
}

const command = cmd({ pattern: 'kk', alias: ['unwrap', 'readvo'], desc: 'Send replied view-once media to sudo', category: 'owner',
  filename: __filename, use: '<reply to view-once media>' }, unwrap)
// The legacy tools bundle also registers kk. Keep this handler first and
// unique, otherwise the older command can intercept the user's reply.
setImmediate(() => {
  for (let i = commands.length - 1; i >= 0; i--) {
    if (commands[i] !== command && commands[i].pattern === 'kk') commands.splice(i, 1)
  }
})
module.exports = { unwrap }
