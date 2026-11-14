'use strict'
const fs = require('fs'), path = require('path')
const { cmd } = require('../lib/plugins')
const { isOperator } = require('../lib/safful-identities')
const { inspectContent, quotedReference, rawQuotedPayload, originalFromStore, download, mediaPayload } = require('../lib/safful-status-media')
const settingsFile = process.env.SAFFUL_ASTATUS_FILE || path.join(__dirname, '..', 'lib', 'safful-astatus.json')
const trigger = /\b(?:send|snd|sent|snt|ayak|sd|st|ayakko|cent|cnt|cend)\b/i
let enabled = true
try {
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  if (typeof saved.enabled === 'boolean') enabled = saved.enabled
} catch {}

async function configure(message, text, meta = {}) {
  if (!await isOperator(message, meta, meta.Void || message.bot)) return message.reply('Owner only.')
  const option = String(text || '').trim().toLowerCase()
  if (!option || ['status', 'get'].includes(option)) return message.reply(
    `Auto status reply: ${enabled ? 'ON' : 'OFF'}.`)
  if (!['on', 'off'].includes(option)) return message.reply('Use .astatus on, off, or status.')
  try {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify({ enabled: option === 'on' }) + '\n')
    fs.renameSync(settingsFile + '.tmp', settingsFile)
    enabled = option === 'on'
  } catch (error) {
    console.error('[astatus] settings failed:', error)
    return message.reply('Could not save settings. Try again.')
  }
  return message.reply(`Auto status reply is ${enabled ? 'ON' : 'OFF'}.`)
}

function replyContext(message, meta) {
  const queue = [meta?.mek?.message, message?.fakeObj?.message, message?.message], seen = new Set()
  while (queue.length) {
    const node = queue.shift()
    if (!node || typeof node !== 'object' || Buffer.isBuffer(node) || seen.has(node)) continue
    seen.add(node)
    if (node.contextInfo?.stanzaId) return node.contextInfo
    queue.push(...Object.values(node))
  }
  return null
}

async function autoReply(message, text, meta = {}) {
  if (!enabled || message.fromMe || message.key?.fromMe || message.isGroup ||
    String(message.chat).endsWith('@g.us') || !trigger.test(String(text || '').trim())) return
  const context = replyContext(message, meta)
  const quoted = message.quoted || message.data?.reply_message
  // Never infer a status from an ordinary private-chat quote.
  const chat = context?.remoteJid || quoted?.key?.remoteJid || quoted?.fakeObj?.key?.remoteJid
  if (chat !== 'status@broadcast') return
  const socket = meta.Void || message.bot
  try {
    const reference = quotedReference(message, meta)
    reference.chat = chat
    reference.id ||= quoted?.key?.id || quoted?.id || ''
    let original = await originalFromStore(meta.store, reference)
    for (const target of [quoted, message]) {
      if (!original && typeof target?.getQuotedObj === 'function') {
        try { original = await target.getQuotedObj() } catch {}
      }
    }
    let found, fallbackText = ''
    for (const candidate of [original?.message, original, quoted?.message,
      quoted?.fakeObj?.message, quoted?.quotedMessage, quoted, rawQuotedPayload(message, meta)]) {
      const content = inspectContent(candidate)
      if (content?.kind === 'text' && !fallbackText) fallbackText = content.text
      if (content && content.kind !== 'text') { found = content; break }
    }
    if (found) {
      const raw = original?.key ? original : { key: { remoteJid: chat, id: reference.id,
        participant: context?.participant || quoted?.key?.participant }, message: { [found.type]: found.media } }
      const bytes = await download(socket, found, raw)
      return await socket.sendMessage(message.chat, mediaPayload(found, bytes))
    }
    if (fallbackText && (original || quoted?.message?.conversation ||
      quoted?.quotedMessage?.conversation || context?.quotedMessage?.conversation)) {
      return await socket.sendMessage(message.chat, { text: fallbackText })
    }
    return await message.reply('Status media unavailable.')
  } catch (error) {
    console.error('[astatus] status delivery failed:', error)
    return message.reply('Could not send this status. Try again.')
  }
}

cmd({ pattern: 'astatus', alias: ['autostatus', 'statusreply'], category: 'status',
  desc: 'Send status media or text to someone who replies with send/snd/sent', use: '<on|off|status>' }, configure)
cmd({ on: 'text', dontAddCommandList: true }, autoReply)
module.exports = { getEnabled: () => enabled, configure, autoReply }
