const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')
const registry = require('../lib/plugins')

const automodTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-automod-test-'))
process.env.SAFFUL_AUTOMOD_FILE = path.join(automodTestDirectory, 'automod.json')

require('../plugins/auto-moderation')
require('../plugins/safful-command-reliability')
require('../plugins/safful-group-reliability')

function handler(pattern) {
  const command = registry.commands.find(item => item.pattern === pattern)
  assert(command, `Missing command: ${pattern}`)
  assert.strictEqual(typeof command.function, 'function', `Missing handler: ${pattern}`)
  return command.function
}

function directMessage(overrides = {}) {
  const replies = []
  const sends = []
  const bot = {
    user: { id: '999999999@s.whatsapp.net' },
    async sendMessage(chat, content) {
      sends.push({ chat, content })
      return { key: { id: `sent-${sends.length}`, remoteJid: chat } }
    },
  }
  return {
    message: {
      chat: '111111111@s.whatsapp.net',
      bot,
      async reply(text) {
        replies.push(String(text))
        return { key: { id: `reply-${replies.length}`, remoteJid: this.chat } }
      },
      ...overrides,
    },
    replies,
    sends,
  }
}

async function testTextCommands() {
  const encoded = directMessage()
  await handler('ebinary')(encoded.message, 'Hi', { smd: 'ebinary' })
  assert.strictEqual(encoded.replies.at(-1), '01001000 01101001')

  const decoded = directMessage()
  await handler('dbinary')(decoded.message, '01001000 01101001', { smd: 'dbinary' })
  assert.strictEqual(decoded.replies.at(-1), 'Hi')

  const badBinary = directMessage()
  await handler('dbinary')(badBinary.message, '0101', { smd: 'dbinary' })
  assert.match(badBinary.replies.at(-1), /groups of 8/i)

  for (const pattern of ['truth', 'dare', 'joke', 'fact', 'quotes', 'question']) {
    const sample = directMessage()
    await handler(pattern)(sample.message, '', { smd: pattern })
    assert(sample.replies.at(-1).length > 10, `${pattern} returned too little text`)
  }

  const ping = directMessage()
  await handler('ping')(ping.message, '', { smd: 'ping' })
  const pingText = ping.sends.at(-1)?.content?.text || ping.replies.at(-1)
  assert.match(pingText, /Pong.*\d+ ms/i)
}

async function testImageCommands() {
  const png = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 1 } },
  }).png().toBuffer()

  const qr = directMessage()
  await handler('qr')(qr.message, 'https://example.com', { smd: 'qr' })
  assert(Buffer.isBuffer(qr.sends.at(-1)?.content?.image), 'QR command did not send an image buffer')

  const sticker = directMessage({
    quoted: { mtype: 'imageMessage', async download() { return png } },
  })
  sticker.message.bot.sendMessage = async (chat, content) => {
    assert(content?.sticker?.url, 'Sticker command did not provide a sticker file')
    assert(require('fs').existsSync(content.sticker.url), 'Sticker file did not exist while sending')
    sticker.sends.push({ chat, content })
    return { key: { id: 'sticker' } }
  }
  await handler('sticker')(sticker.message, '', { smd: 'sticker' })
  assert.strictEqual(sticker.sends.length, 1)

  const photo = directMessage({
    quoted: { mtype: 'stickerMessage', async download() { return await sharp(png).webp().toBuffer() } },
  })
  await handler('photo')(photo.message, '', { smd: 'photo' })
  assert(Buffer.isBuffer(photo.sends.at(-1)?.content?.image), 'Photo command did not send an image')
}

async function testAutoModerationHelpers() {
  const automod = require('../plugins/auto-moderation')
  assert(automod.containsBlockedPhrase('That BAD word is here', ['bad word']))
  assert(!automod.containsBlockedPhrase('badminton is a sport', ['bad']))

  const sample = directMessage({
    chat: '12345-67890@g.us',
    isGroup: true,
    sender: '111111111@s.whatsapp.net',
    key: { participant: '111111111@s.whatsapp.net' },
    metadata: {
      id: '12345-67890@g.us',
      participants: [
        { id: '111111111@s.whatsapp.net', admin: 'admin' },
        { id: '999999999@s.whatsapp.net', admin: 'admin' },
      ],
    },
  })

  await handler('antibadword')(sample.message, 'rude, very bad, rude', { smd: 'antibadword' })
  assert.match(sample.replies.at(-1), /Added 2/i)
  let saved = automod.loadSettings()
  assert.deepStrictEqual(saved['badwords:12345-67890@g.us'], ['rude', 'very bad'])
  assert.strictEqual(saved['antibadword:12345-67890@g.us'], true)

  const modulePath = require.resolve('../plugins/auto-moderation')
  delete require.cache[modulePath]
  const afterReboot = require('../plugins/auto-moderation')
  saved = afterReboot.loadSettings()
  assert.deepStrictEqual(saved['badwords:12345-67890@g.us'], ['rude', 'very bad'], 'bad words should survive a reboot')
  assert.strictEqual(saved['antibadword:12345-67890@g.us'], true, 'enabled state should survive a reboot')

  await handler('antibadword')(sample.message, 'remove rude, missing', { smd: 'antibadword' })
  assert.deepStrictEqual(afterReboot.loadSettings()['badwords:12345-67890@g.us'], ['very bad'])
}

async function testGroupCommands() {
  const actions = []
  const settings = []
  const participants = [
    { id: '111111111@s.whatsapp.net', admin: 'admin' },
    { id: '999999999@s.whatsapp.net', admin: 'admin' },
    { id: '222222222@s.whatsapp.net', admin: null },
  ]
  const sample = directMessage({
    chat: '12345-67890@g.us',
    isGroup: true,
    sender: '111111111@s.whatsapp.net',
    key: { participant: '111111111@s.whatsapp.net' },
    metadata: { id: '12345-67890@g.us', subject: 'Test Group', participants },
  })
  Object.assign(sample.message.bot, {
    async groupMetadata() { return sample.message.metadata },
    async groupParticipantsUpdate(chat, jids, action) {
      actions.push({ chat, jids, action })
      return [{ status: '200' }]
    },
    async groupSettingUpdate(chat, setting) {
      settings.push({ chat, setting })
    },
  })

  await handler('kick')(sample.message, '222222222', { smd: 'kick' })
  assert.deepStrictEqual(actions.at(-1), {
    chat: '12345-67890@g.us',
    jids: ['222222222@s.whatsapp.net'],
    action: 'remove',
  })

  await handler('group')(sample.message, 'close', { smd: 'group' })
  assert.strictEqual(settings.at(-1)?.setting, 'announcement')

  await handler('tagall')(sample.message, 'Hello', { smd: 'tagall' })
  assert.strictEqual(sample.sends.at(-1)?.content?.mentions?.length, 3)
}

async function main() {
  await testTextCommands()
  await testImageCommands()
  await testAutoModerationHelpers()
  await testGroupCommands()

  const names = new Map()
  for (const command of registry.commands) {
    for (const name of [command.pattern].concat(command.alias || []).filter(Boolean)) {
      names.set(name, (names.get(name) || 0) + 1)
    }
  }
  for (const required of ['ping', 'ig', 'sticker', 'dbinary', 'antibadword', 'kick']) {
    assert.strictEqual(names.get(required), 1, `Expected exactly one ${required} registration`)
  }

  process.stdout.write(`Command reliability tests passed (${registry.commands.length} registrations).\n`)
}

main().then(() => {
  fs.rmSync(automodTestDirectory, { recursive: true, force: true })
  process.exit(0)
}).catch(error => {
  fs.rmSync(automodTestDirectory, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})
