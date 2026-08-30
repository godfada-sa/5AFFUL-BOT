const fs = require('fs')
const path = require('path')
const { cmd, commands } = require('../lib/plugins')

const SETTINGS_FILE = path.resolve(
  process.env.SAFFUL_AUTOMOD_FILE || path.join(__dirname, '..', '.safful-data', 'automod.json')
)
const LEGACY_SETTINGS_FILE = path.join(__dirname, '..', '.safful-temp', 'automod.json')
const attachedSockets = new WeakSet()
const AUTOMOD_COMMANDS = new Set([
  'antisticker', 'antistk', 'antiimage', 'antiimg', 'antivideo', 'antivid',
  'antilink', 'antilinks', 'antibadword', 'badword', 'badwords',
  'addbadword', 'delbadword', 'clearbadwords',
])

for (let index = commands.length - 1; index >= 0; index -= 1) {
  const command = commands[index]
  const names = [command?.pattern, command?.cmdname]
    .concat(Array.isArray(command?.alias) ? command.alias : [])
    .filter(Boolean)
    .map(name => String(name).toLowerCase())
  if (names.some(name => AUTOMOD_COMMANDS.has(name))) commands.splice(index, 1)
}

function log(message) {
  process.stderr.write(`[safful-automod] ${message}\n`)
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8') || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function loadSettings() {
  const current = readSettings(SETTINGS_FILE) || readSettings(`${SETTINGS_FILE}.bak`)
  if (current) return current

  const legacy = readSettings(LEGACY_SETTINGS_FILE)
  if (!legacy) return {}
  try { saveSettings(legacy) } catch {}
  return legacy
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  const temporary = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8')
  if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak`)
  fs.renameSync(temporary, SETTINGS_FILE)
}

function normalizeJid(value) {
  return String(value || '')
    .replace(/:\d+@/g, '@')
    .replace(/@c\.us$/i, '@s.whatsapp.net')
}

function identitySet(values) {
  const result = new Set()
  for (const value of values.flat(Infinity)) {
    const jid = normalizeJid(value)
    if (!jid) continue
    result.add(jid)
    const number = jid.split('@')[0].replace(/\D/g, '')
    if (number) result.add(number)
  }
  return result
}

function participantIdentities(participant) {
  return identitySet([participant?.id, participant?.lid, participant?.phoneNumber])
}

function identitiesOverlap(left, right) {
  const a = left instanceof Set ? left : identitySet(left)
  const b = right instanceof Set ? right : identitySet(right)
  for (const value of a) if (b.has(value)) return true
  return false
}

function configuredOwners() {
  return identitySet(
    String(process.env.SUDO || process.env.OWNER_NUMBER || global.sudo || global.owner || '')
      .match(/\d{7,}/g) || []
  )
}

function senderIdentities(message, extra = {}) {
  return identitySet([
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    extra?.mek?.key?.participant,
    extra?.mek?.key?.participantAlt,
  ])
}

function chatKeys(chat) {
  const jid = normalizeJid(chat)
  const number = jid.split('@')[0].replace(/\D/g, '')
  return [jid, number].filter(Boolean)
}

function settingEnabled(settings, feature, chat) {
  return chatKeys(chat).some(key => settings[`${feature}:${key}`] === true)
}

function settingValue(settings, feature, chat, fallback) {
  for (const key of chatKeys(chat)) {
    if (settings[`${feature}:${key}`] !== undefined) return settings[`${feature}:${key}`]
  }
  return fallback
}

function setSetting(settings, feature, chat, value) {
  const [current, legacy] = chatKeys(chat)
  if (!current) return
  if (value === undefined) delete settings[`${feature}:${current}`]
  else settings[`${feature}:${current}`] = value
  if (legacy && legacy !== current) delete settings[`${feature}:${legacy}`]
}

async function groupMetadata(message) {
  if (message?.metadata?.participants?.length) return message.metadata
  const socket = message?.bot || message?.client || global.__saffulLatestSocket
  if (!message?.chat || typeof socket?.groupMetadata !== 'function') return null
  try {
    return await socket.groupMetadata(message.chat)
  } catch {
    return null
  }
}

async function canConfigure(message, extra) {
  if (message?.fromMe || extra?.isCreator) return true
  if (identitiesOverlap(senderIdentities(message, extra), configuredOwners())) return true
  const metadata = await groupMetadata(message)
  const sender = senderIdentities(message, extra)
  return Boolean(metadata?.participants?.some(
    participant => participant?.admin && identitiesOverlap(sender, participantIdentities(participant))
  ))
}

async function requireGroupAdmin(message, extra) {
  if (!message?.isGroup && !String(message?.chat || '').endsWith('@g.us')) {
    await message.reply('This command only works in a group.')
    return false
  }
  if (await canConfigure(message, extra)) return true
  await message.reply('Only a group admin or the bot owner can change auto-moderation.')
  return false
}

function registerToggle(pattern, aliases, feature, label, description) {
  cmd({ pattern, alias: aliases, desc: description, category: 'automod', use: '<on|off|status>' }, async (message, text, extra = {}) => {
    if (!(await requireGroupAdmin(message, extra))) return
    const input = String(text || '').trim().toLowerCase()
    const settings = loadSettings()
    const enabled = settingEnabled(settings, feature, message.chat)

    if (!input || input === 'status') {
      return message.reply(`${label}: *${enabled ? 'ON' : 'OFF'}*\nUse \`.${pattern} on\` or \`.${pattern} off\`.`)
    }
    if (!['on', 'enable', 'off', 'disable'].includes(input)) {
      return message.reply(`Usage: \`.${pattern} on\` or \`.${pattern} off\``)
    }

    const turnOn = input === 'on' || input === 'enable'
    setSetting(settings, feature, message.chat, turnOn ? true : undefined)
    saveSettings(settings)
    return message.reply(`${label} is now *${turnOn ? 'ON' : 'OFF'}*.`)
  })
}

registerToggle('antisticker', ['antistk'], 'antisticker', '🧩 Anti-sticker', 'Delete stickers sent by non-admins')
registerToggle('antiimage', ['antiimg'], 'antiimage', '🖼️ Anti-image', 'Delete images sent by non-admins')
registerToggle('antivideo', ['antivid'], 'antivideo', '🎥 Anti-video', 'Delete videos sent by non-admins')
registerToggle('antilink', ['antilinks'], 'antilink', '🔗 Anti-link', 'Delete links sent by non-admins')

function normalizedWords(value) {
  return Array.from(new Set(
    String(value || '')
      .split(',')
      .map(word => word.trim().toLowerCase())
      .filter(word => word && word.length <= 80)
  ))
}

function badwordState(message) {
  const settings = loadSettings()
  const stored = settingValue(settings, 'badwords', message.chat, [])
  const words = normalizedWords(Array.isArray(stored) ? stored.join(',') : stored)
  return { settings, words }
}

async function showBadwordStatus(message) {
  const { settings, words } = badwordState(message)
  const enabled = settingEnabled(settings, 'antibadword', message.chat)
  return message.reply([
    `🚫 Anti-badword: *${enabled ? 'ON' : 'OFF'}*`,
    `Words: ${words.length ? words.map(word => `\`${word}\``).join(', ') : 'none'}`,
    'Add: `.antibadword word, another phrase`',
    'Remove: `.antibadword remove word, another phrase`',
  ].join('\n'))
}

async function addBadwords(message, text) {
  const additions = normalizedWords(text)
  if (!additions.length) return message.reply('Usage: `.antibadword word, another word, phrase`')
  const { settings, words } = badwordState(message)
  const combined = Array.from(new Set(words.concat(additions))).slice(0, 200)
  const added = additions.filter(word => !words.includes(word))
  setSetting(settings, 'badwords', message.chat, combined)
  setSetting(settings, 'antibadword', message.chat, true)
  saveSettings(settings)
  return message.reply(added.length
    ? `✅ Added ${added.length}: *${added.join(', ')}*\n🚫 Anti-badword is *ON*.`
    : 'ℹ️ Those words are already in the list. Anti-badword remains ON.')
}

async function removeBadwords(message, text) {
  const removals = normalizedWords(text)
  if (!removals.length) return message.reply('Usage: `.antibadword remove word, another word`')
  const { settings, words } = badwordState(message)
  const remaining = words.filter(word => !removals.includes(word))
  const removed = words.filter(word => removals.includes(word))
  setSetting(settings, 'badwords', message.chat, remaining)
  saveSettings(settings)
  return message.reply(removed.length ? `✅ Removed: *${removed.join(', ')}*` : 'Those entries were not in the list.')
}

async function requireBadwordAdmin(message, extra, operation) {
  if (!(await requireGroupAdmin(message, extra))) return
  return operation()
}

cmd({
  pattern: 'antibadword',
  desc: 'Add bad words or configure the group bad-word filter',
  category: 'automod',
  use: '<word, phrase|on|off|status|remove|clear>',
}, async (message, text, extra = {}) => requireBadwordAdmin(message, extra, async () => {
  const input = String(text || '').trim()
  const normalized = input.toLowerCase()

  if (!input || ['status', 'list'].includes(normalized)) return showBadwordStatus(message)
  if (normalized === 'clear') {
    const { settings } = badwordState(message)
    setSetting(settings, 'badwords', message.chat, [])
    saveSettings(settings)
    return message.reply('✅ The bad-word list has been cleared.')
  }
  if (/^(remove|delete|del)\s+/i.test(input)) {
    return removeBadwords(message, input.replace(/^(remove|delete|del)\s+/i, ''))
  }
  if (/^add\s+/i.test(input)) return addBadwords(message, input.replace(/^add\s+/i, ''))

  if (['on', 'enable', 'off', 'disable'].includes(normalized)) {
    const { settings, words } = badwordState(message)
    const turnOn = normalized === 'on' || normalized === 'enable'
    setSetting(settings, 'antibadword', message.chat, turnOn ? true : undefined)
    saveSettings(settings)
    const warning = turnOn && !words.length ? '\nAdd words with `.antibadword word, phrase`.' : ''
    return message.reply(`🚫 Anti-badword is now *${turnOn ? 'ON' : 'OFF'}*.${warning}`)
  }

  return addBadwords(message, input)
}))

cmd({
  pattern: 'addbadword',
  alias: ['badword'],
  desc: 'Add one or more comma-separated bad words',
  category: 'automod',
  use: '<word, phrase>',
}, async (message, text, extra = {}) => requireBadwordAdmin(message, extra, () => addBadwords(message, text)))

cmd({
  pattern: 'delbadword',
  desc: 'Remove one or more comma-separated bad words',
  category: 'automod',
  use: '<word, phrase>',
}, async (message, text, extra = {}) => requireBadwordAdmin(message, extra, () => removeBadwords(message, text)))

cmd({
  pattern: 'clearbadwords',
  desc: 'Clear the group bad-word list',
  category: 'automod',
}, async (message, text, extra = {}) => requireBadwordAdmin(message, extra, async () => {
    const { settings } = badwordState(message)
    setSetting(settings, 'badwords', message.chat, [])
    saveSettings(settings)
    return message.reply('✅ The bad-word list has been cleared.')
}))

cmd({
  pattern: 'badwords',
  desc: 'Show anti-badword status and saved words',
  category: 'automod',
}, async (message, text, extra = {}) => requireBadwordAdmin(message, extra, () => showBadwordStatus(message)))

function unwrapMessage(message) {
  let content = message || {}
  for (let depth = 0; depth < 4; depth += 1) {
    const wrapped = content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.viewOnceMessageV2Extension?.message ||
      content.documentWithCaptionMessage?.message
    if (!wrapped) break
    content = wrapped
  }
  return content
}

function messageText(content) {
  return String(
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
  )
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsBlockedPhrase(text, phrases) {
  const normalized = String(text || '').toLowerCase()
  return phrases.some(phrase => {
    const clean = String(phrase || '').trim().toLowerCase()
    if (!clean) return false
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapedRegExp(clean)}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(normalized)
  })
}

function attach(socket) {
  if (!socket?.ev?.on || attachedSockets.has(socket)) return
  attachedSockets.add(socket)

  socket.ev.on('messages.upsert', async ({ messages = [] } = {}) => {
    const settings = loadSettings()
    for (const raw of messages) {
      try {
        if (raw?.key?.fromMe) continue
        const chat = normalizeJid(raw?.key?.remoteJid)
        if (!chat.endsWith('@g.us')) continue

        const content = unwrapMessage(raw?.message)
        const type = Object.keys(content || {})[0] || ''
        const text = messageText(content)
        const featuresEnabled = ['antisticker', 'antiimage', 'antivideo', 'antilink', 'antibadword']
          .some(feature => settingEnabled(settings, feature, chat))
        if (!featuresEnabled) continue

        let metadata
        try { metadata = await socket.groupMetadata(chat) } catch { continue }
        const sender = identitySet([raw?.key?.participant, raw?.key?.participantAlt])
        const bot = identitySet([socket?.user?.id, socket?.user?.lid, socket?.user?.phoneNumber])
        const senderIsAdmin = metadata?.participants?.some(participant => participant?.admin && identitiesOverlap(sender, participantIdentities(participant)))
        const botIsAdmin = metadata?.participants?.some(participant => participant?.admin && identitiesOverlap(bot, participantIdentities(participant)))
        if (senderIsAdmin || !botIsAdmin) continue

        let reason = ''
        if (type === 'stickerMessage' && settingEnabled(settings, 'antisticker', chat)) reason = 'sticker'
        else if (type === 'imageMessage' && settingEnabled(settings, 'antiimage', chat)) reason = 'image'
        else if (type === 'videoMessage' && settingEnabled(settings, 'antivideo', chat)) reason = 'video'
        else if (settingEnabled(settings, 'antilink', chat) && /(?:https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text)) reason = 'link'
        else if (settingEnabled(settings, 'antibadword', chat)) {
          const words = settingValue(settings, 'badwords', chat, [])
          if (containsBlockedPhrase(text, words)) reason = 'bad word'
        }

        if (!reason) continue
        await socket.sendMessage(chat, { delete: raw.key })
        log(`Deleted ${reason} message in ${chat.split('@')[0]}`)
      } catch (error) {
        log(`Moderation error: ${error?.message || error}`)
      }
    }
  })

  log('Message moderation hook attached')
}

module.exports = {
  SETTINGS_FILE,
  attach,
  containsBlockedPhrase,
  loadSettings,
  saveSettings,
  settingEnabled,
}
