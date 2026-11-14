'use strict'

const { downloadContentFromMessage } = require('@whiskeysockets/baileys')
const fs = require('fs')
const path = require('path')
const { cmd, commands } = require('../lib/plugins')
const { resolvePhone, ownerJids, senderIds, isOperator } = require('../lib/safful-identities')
const viewOnceDetector = require('../lib/safful-viewonce-detector')
const { detectViewOnce } = viewOnceDetector

const VIEW_ONCE_WRAPPERS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
]
const MESSAGE_CONTAINERS = ['ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage',
  'editedMessage', 'associatedChildMessage']
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'ptvMessage'])
const SETTINGS_FILE = process.env.SAFFUL_ANTIVIEWONCE_FILE || path.join(__dirname, '..', '.safful-data', 'antiviewonce.json')
const stats = { detected: 0, sent: 0, recovered: 0, failed: 0, unavailable: 0, lastError: '' }
const processed = new Set(), pending = new Set(), unavailableIds = new Set()

// Late-arrival retry: WhatsApp sometimes delivers the media for a view-once
// message minutes after the initial "unavailable" notice (reconnect history
// sync, slow fanout). Queued notices are re-checked periodically for a short
// window before giving up. Override the window with SAFFUL_ANTIVIEWONCE_RETRY_MS.
const RETRY_WINDOW_MS = Math.max(30 * 1000, Number(process.env.SAFFUL_ANTIVIEWONCE_RETRY_MS) || 5 * 60 * 1000)
const RETRY_INTERVAL_MS = 20 * 1000
const retryQueue = new Map()
let activeSocket = null

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return { global: settings?.global === true,
      contacts: Array.isArray(settings?.contacts) ? settings.contacts.map(numberFrom).filter(Boolean) : [] }
  } catch {
    return { global: false, contacts: [] }
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  const temporary = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8')
  fs.renameSync(temporary, SETTINGS_FILE)
}

function numberFrom(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

async function enabledForMessage(message, socket) {
  const settings = loadSettings()
  if (settings.global) return true
  if (!Array.isArray(settings.contacts) || !settings.contacts.length) return false
  const jid = await resolvePhone(socket, ...senderIds(message))
  return Boolean(jid && settings.contacts.includes(jid.split('@')[0]))
}

function removeCommands(names) {
  const wanted = new Set(names.map(name => String(name).toLowerCase()))
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]
    const namesForCommand = [command?.pattern, command?.cmdname]
      .concat(Array.isArray(command?.alias) ? command.alias : [])
      .filter(Boolean)
      .map(name => String(name).toLowerCase())
    if (namesForCommand.some(name => wanted.has(name))) commands.splice(index, 1)
  }
}

function ownerJid(socket) { return ownerJids(socket)[0] || null }

function unwrapViewOnce(content, seenViewOnce = false) {
  if (!content || typeof content !== 'object') return null

  for (const wrapper of VIEW_ONCE_WRAPPERS) {
    if (content[wrapper]?.message) return unwrapViewOnce(content[wrapper].message, true)
  }
  for (const wrapper of MESSAGE_CONTAINERS) {
    const container = content[wrapper]
    const nested = container?.message || container?.editedMessage || container?.associatedChildMessage
    if (nested) {
      const result = unwrapViewOnce(nested, seenViewOnce)
      if (result) return result
    }
  }

  for (const type of MEDIA_TYPES) {
    if (content[type] && (seenViewOnce || content[type].viewOnce)) {
      return { type, media: content[type] }
    }
  }
  return null
}

const MAX_BYTES = 64 * 1024 * 1024
async function streamToBuffer(stream) {
  const chunks = []
  let length = 0
  for await (const chunk of stream) {
    length += chunk.length
    if (length > MAX_BYTES) throw new Error('View-once media exceeds 64 MB')
    chunks.push(Buffer.from(chunk))
  }
  if (!length) throw new Error('WhatsApp returned empty media')
  return Buffer.concat(chunks)
}

async function downloadViewOnce(socket, message, unwrapped) {
  const mediaType = unwrapped.type === 'ptvMessage' ? 'video' : unwrapped.type.replace('Message', '')
  const download = async media => streamToBuffer(await downloadContentFromMessage(media, mediaType, { options: { timeout: 30000 } }))
  try { return await download(unwrapped.media) } catch (error) {
    const status = error.status || error.response?.status || error.output?.statusCode
    if (![404, 410].includes(status) || typeof socket.updateMediaMessage !== 'function') throw error
    // Preserve the key and media for Baileys' supported re-upload request.
    const normalized = { ...message, message: { [unwrapped.type]: { ...unwrapped.media } } }
    const updated = await socket.updateMediaMessage(normalized)
    // Recent clients may return the refreshed media inside a view-once or
    // ephemeral wrapper rather than at message.<type>.
    const refreshed = detectViewOnce(updated) || unwrapViewOnce(updated?.message || updated, true)
    return download(refreshed?.media || updated?.message?.[unwrapped.type] || normalized.message[unwrapped.type])
  }
}

function forwardedContent(unwrapped, buffer) {
  const kind = unwrapped.type === 'ptvMessage' ? 'video' : unwrapped.type.replace('Message', '')
  if (kind === 'audio') return { audio: buffer, mimetype: unwrapped.media.mimetype || 'audio/ogg; codecs=opus', ptt: Boolean(unwrapped.media.ptt) }
  const caption = String(unwrapped.media.caption || '').trim()
  return { [kind]: buffer, mimetype: unwrapped.media.mimetype,
    caption: 'View-once media' + (caption ? '\n\n' + caption : '') }
}

function remember(set, id) {
  set.add(id)
  if (set.size > 1000) set.delete(set.values().next().value)
}

function queueUnavailable(raw) {
  const id = raw?.key?.remoteJid + ':' + raw?.key?.id
  if (!raw?.key?.id || processed.has(id)) return
  const existing = retryQueue.get(id)
  if (existing && !detectViewOnce(raw)) return
  // Replace an unavailable notice when the real payload finally arrives.
  retryQueue.set(id, { raw, queuedAt: existing?.queuedAt || Date.now() })
  if (retryQueue.size > 300) retryQueue.delete(retryQueue.keys().next().value)
}

async function attemptQueued(entry) {
  const raw = entry.raw
  const detected = detectViewOnce(raw)
  // Still no media payload delivered — keep waiting inside the window.
  if (!detected) return false
  const id = raw.key.remoteJid + ':' + raw.key.id
  // Captured by the live path in the meantime — nothing left to do.
  if (processed.has(id)) return true
  if (pending.has(id)) return false
  if (global.saffulChatbotPaused === true || raw.key?.fromMe || raw.key?.remoteJid === 'status@broadcast') return false
  if (!activeSocket) return false
  pending.add(id)
  try {
    if (!await enabledForMessage(raw, activeSocket)) return true
    const destination = ownerJid(activeSocket)
    if (!destination) return false
    const buffer = await downloadViewOnce(activeSocket, raw, detected)
    if (global.saffulChatbotPaused === true) return false
    await activeSocket.sendMessage(destination, forwardedContent(detected, buffer))
    remember(processed, id)
    stats.recovered++
    stats.lastError = ''
    return true
  } catch (error) {
    stats.lastError = String(error?.message || error).slice(0, 250)
    return false
  } finally { pending.delete(id) }
}

function runRetryCycle() {
  const now = Date.now()
  for (const [id, entry] of retryQueue) {
    if (now - entry.queuedAt > RETRY_WINDOW_MS) { retryQueue.delete(id); continue }
    if (processed.has(id)) { retryQueue.delete(id); continue }
    if (pending.has(id)) continue
    void attemptQueued(entry).then(done => { if (done) retryQueue.delete(id) }).catch(() => {})
  }
}

let retryLoopStarted = false
function startRetryLoop() {
  if (retryLoopStarted) return
  retryLoopStarted = true
  const timer = setInterval(runRetryCycle, RETRY_INTERVAL_MS)
  timer.unref?.()
}

function attach(socket) {
  if (!socket?.ev || socket.__saffulAntiViewOnceAttached) return
  socket.__saffulAntiViewOnceAttached = true
  activeSocket = socket
  startRetryLoop()
  viewOnceDetector.attach(socket, async (message, detected) => {
    if (global.saffulChatbotPaused === true || message.key?.fromMe || message.key?.remoteJid === 'status@broadcast') return
    const id = message.key?.remoteJid + ':' + message.key?.id
    if (!message.key?.id || processed.has(id) || pending.has(id)) return
    pending.add(id)
    try {
      if (!await enabledForMessage(message, socket)) return
      stats.detected++
      const destination = ownerJid(socket)
      if (!destination) throw new Error('No SUDO, owner, or personal destination available')
      const buffer = await downloadViewOnce(socket, message, detected)
      if (global.saffulChatbotPaused === true) return
      await socket.sendMessage(destination, forwardedContent(detected, buffer))
      remember(processed, id)
      stats.sent++
      stats.lastError = ''
    } catch (error) {
      stats.failed++
      stats.lastError = String(error?.message || error).slice(0, 250)
      process.stderr.write('[antiviewonce] Capture failed: ' + stats.lastError + '\n')
      // The media payload exists but the capture failed (reupload needed,
      // network hiccup, media server 404). Queue for the retry window — most
      // of these succeed on a later attempt.
      queueUnavailable(message)
    } finally { pending.delete(id) }
  }, message => {
    if (global.saffulChatbotPaused === true || message.key?.remoteJid === 'status@broadcast') return
    const id = message.key?.remoteJid + ':' + message.key?.id
    if (unavailableIds.has(id)) return
    remember(unavailableIds, id)
    void enabledForMessage(message, socket).then(enabled => {
      if (!enabled) return
      stats.unavailable++
      queueUnavailable(message)
    }).catch(() => {})
  })
}

function installCommand() {
  // This is deliberately callable again after the legacy plugin loader runs.
  // It guarantees the maintained handler is the final registration and cannot
  // be shadowed by an older anti-view-once command.
  removeCommands(['antiviewonce', 'avo'])
  cmd({
    pattern: 'antiviewonce',
    alias: ['avo'],
    desc: 'Capture view-once media globally or from selected contacts',
    category: 'owner',
    use: 'on | off | <number> | off <number> | status',
    filename: __filename,
  }, async (message, text, extra) => {
    if (!await isOperator(message, extra, extra?.Void || message.bot || global.__saffulLatestSocket)) return message.reply('❌ Owner only.')
    const input = String(text || '').trim().toLowerCase()
    const settings = loadSettings()
    settings.contacts = Array.from(new Set((settings.contacts || []).map(numberFrom).filter(Boolean)))

    if (!input || input === 'status') {
      return message.reply(`Anti-view-once: ${settings.global ? 'ON' : 'OFF'}\nContact rules: ${settings.contacts.length}\nSent: ${stats.sent} | Recovered: ${stats.recovered} | Failed: ${stats.failed} | Unavailable: ${stats.unavailable}`)
    }
    if (input === 'on' || input === 'enable') {
      settings.global = true
      saveSettings(settings)
      return message.reply('Anti-view-once: ON globally.')
    }
    if (input === 'off' || input === 'disable') {
      settings.global = false
      saveSettings(settings)
      return message.reply('Global anti-view-once: OFF.' + (settings.contacts.length ? ' Contact rules still apply.' : ''))
    }

    const disable = /^(off|remove|delete)\s+/.test(input)
    const number = numberFrom(input.replace(/^(off|remove|delete)\s+/, ''))
    if (number.length < 7 || number.length > 15) {
      return message.reply('Usage: `.antiviewonce <number>`, `.antiviewonce off <number>`, or `.antiviewonce on`.')
    }
    if (disable) {
      settings.contacts = settings.contacts.filter(contact => contact !== number)
      saveSettings(settings)
      return message.reply(`🔒 Anti-view-once disabled for +${number}.`)
    }
    if (!settings.contacts.includes(number)) settings.contacts.push(number)
    saveSettings(settings)
    return message.reply(`🔓 Anti-view-once enabled for +${number}.`)
  })
}

installCommand()

module.exports = {
  attach,
  stats,
  retryQueue,
  attemptQueued,
  runRetryCycle,
  RETRY_WINDOW_MS,
  forwardedContent,
  saveSettings,
  unwrapViewOnce,
  ownerJid,
  downloadViewOnce,
  loadSettings,
  enabledForMessage,
  installCommand,
}
