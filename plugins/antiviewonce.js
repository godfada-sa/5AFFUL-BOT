'use strict'

const { downloadContentFromMessage, downloadMediaMessage } = require('@whiskeysockets/baileys')
const fs = require('fs')
const path = require('path')
const { cmd, commands } = require('../lib/plugins')
const { isOwner } = require('../lib/safful-mode')
const { viewOnceMedia, recoverViewOnceMedia } = require('../lib/safful-protection')
const viewOnceDetector = require('../lib/safful-viewonce-detector')

const VIEW_ONCE_WRAPPERS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
]
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage'])
const SETTINGS_FILE = path.join(__dirname, '..', '.safful-data', 'antiviewonce.json')

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return settings && typeof settings === 'object' ? settings : { global: false, contacts: [] }
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
  return String(value || '').replace(/\D/g, '')
}

function selectedContact(settings, message) {
  const sender = numberFrom(message?.key?.participant || message?.key?.remoteJid || message?.participant)
  return Boolean(sender && Array.isArray(settings.contacts) && settings.contacts.includes(sender))
}

function enabledForMessage(message) {
  const settings = loadSettings()
  return Boolean(settings.global || selectedContact(settings, message))
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

function ownerJid() {
  for (const value of [process.env.SUDO, global.sudo, process.env.OWNER_NUMBER, global.owner]) {
    const number = String(value || '').split(/[\s,;]+/)[0].replace(/\D/g, '')
    if (number) return `${number}@s.whatsapp.net`
  }
  return null
}

function unwrapViewOnce(content, seenViewOnce = false) {
  if (!content || typeof content !== 'object') return null

  for (const wrapper of VIEW_ONCE_WRAPPERS) {
    if (content[wrapper]?.message) return unwrapViewOnce(content[wrapper].message, true)
  }
  if (content.ephemeralMessage?.message) return unwrapViewOnce(content.ephemeralMessage.message, seenViewOnce)

  for (const type of MEDIA_TYPES) {
    if (content[type] && (seenViewOnce || content[type].viewOnce)) {
      return { type, media: content[type] }
    }
  }
  return null
}

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function downloadViewOnce(socket, message, unwrapped) {
  const mediaType = unwrapped.type === 'imageMessage' ? 'image' : 'video'
  try {
    return await streamToBuffer(await downloadContentFromMessage(unwrapped.media, mediaType))
  } catch (primaryError) {
    // Asking the linked device to re-upload is the only supported fallback if
    // WhatsApp has already removed the original media URL.
    const normalized = { ...message, message: { [unwrapped.type]: unwrapped.media } }
    try {
      return await downloadMediaMessage(normalized, 'buffer', {}, {
        reuploadRequest: socket.updateMediaMessage?.bind(socket),
      })
    } catch (fallbackError) {
      throw new Error(`media is no longer available (${fallbackError?.message || primaryError?.message || 'download failed'})`)
    }
  }
}

function forwardedContent(unwrapped, buffer) {
  const caption = String(unwrapped.media?.caption || '').trim()
  const notice = '🔓 *View-once media captured automatically*'
  const content = {
    [unwrapped.type === 'imageMessage' ? 'image' : 'video']: buffer,
    mimetype: unwrapped.media?.mimetype,
    caption: caption ? `${notice}\n\n${caption}` : notice,
  }
  return content
}

function attach(socket) {
  if (!socket?.ev?.on || socket.__saffulAntiViewOnceAttached) return
  socket.__saffulAntiViewOnceAttached = true
  const processed = new Set()

  viewOnceDetector.attach(socket, async (message, detected) => {
    const destination = ownerJid()
    if (!destination) return

    const id = message?.key?.id
    if (!id || message?.key?.fromMe || message?.key?.remoteJid === 'status@broadcast' || processed.has(id)) return
    if (!enabledForMessage(message)) return
    // This is the same deep extractor and recovery path used by `.kk`.
    const protectedMedia = viewOnceMedia(message)
    const protectedFallback = protectedMedia?.kind && protectedMedia?.media
      ? { type: `${protectedMedia.kind}Message`, media: protectedMedia.media }
      : null
    const unwrapped = protectedFallback || detected || unwrapViewOnce(message.message)
    if (!unwrapped) return
    processed.add(id)
    if (processed.size > 500) processed.delete(processed.values().next().value)

    process.stdout.write(`[antiviewonce] Detected ${unwrapped.type} ${id}; capturing now.\n`)
    try {
      if (protectedMedia) {
        const recovered = await recoverViewOnceMedia(socket, destination, message, protectedMedia)
        if (recovered) {
          process.stdout.write(`[antiviewonce] Captured ${protectedMedia.kind} ${id} using the .kk recovery path.\n`)
          return
        }
      }
      const buffer = await downloadViewOnce(socket, message, unwrapped)
      await socket.sendMessage(destination, forwardedContent(unwrapped, buffer))
      process.stdout.write(`[antiviewonce] Captured ${unwrapped.type} ${id}.\n`)
    } catch (error) {
      process.stdout.write(`[antiviewonce] Could not capture ${id}: ${error?.message || error}\n`)
    }
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
    if (!isOwner(message, extra)) return message.reply('❌ Owner only.')
    const input = String(text || '').trim().toLowerCase()
    const settings = loadSettings()
    settings.contacts = Array.from(new Set((settings.contacts || []).map(numberFrom).filter(Boolean)))

    if (!input || input === 'status') {
      const contacts = settings.contacts.length ? settings.contacts.map(number => `+${number}`).join(', ') : 'none'
      return message.reply(`🔓 *Anti-view-once*\nGlobal: *${settings.global ? 'ON' : 'OFF'}*\nContacts: ${contacts}\n\nUse \`.antiviewonce on\` for global, or \`.antiviewonce <number>\` for one contact.`)
    }
    if (input === 'on' || input === 'enable') {
      settings.global = true
      saveSettings(settings)
      return message.reply('🔓 Anti-view-once is now *ON globally*.')
    }
    if (input === 'off' || input === 'disable') {
      settings.global = false
      saveSettings(settings)
      return message.reply('🔒 Global anti-view-once is now *OFF*. Contact rules remain unchanged.')
    }

    const disable = /^(off|remove|delete)\s+/.test(input)
    const number = numberFrom(input.replace(/^(off|remove|delete)\s+/, ''))
    if (number.length < 7 || number.length > 16) {
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
  unwrapViewOnce,
  ownerJid,
  downloadViewOnce,
  loadSettings,
  enabledForMessage,
  installCommand,
}
