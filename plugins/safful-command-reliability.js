const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode')
const sharp = require('sharp')
const { cmd, commands } = require('../lib/plugins')
const exif = require('../lib/exif')
const stylish = require('../lib/stylish-font')
const mediaTools = require('../lib')
const social = require('../lib/social-downloader')

const BROKEN_COMMANDS = new Set([
  'attp', 'memegen', 'emix', 'quotely', 'wallpaper', 'ttp', 'paste',
])

function namesOf(command) {
  return [command?.pattern, command?.cmdname]
    .concat(Array.isArray(command?.alias) ? command.alias : [])
    .filter(Boolean)
    .map(name => String(name).toLowerCase().trim())
}

function removeCommands(names) {
  const wanted = new Set(Array.from(names, name => String(name).toLowerCase()))
  let removed = 0
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (!namesOf(commands[index]).some(name => wanted.has(name))) continue
    commands.splice(index, 1)
    removed += 1
  }
  return removed
}

function replaceCommand(config, handler) {
  removeCommands([config.pattern].concat(config.alias || []))
  cmd({ ...config, filename: __filename }, handler)
}

function deduplicateCommands() {
  const seen = new Set()
  let removedCommands = 0
  let removedAliases = 0

  // Later registrations intentionally win. Primary command names are kept;
  // only aliases that would shadow another command are discarded.
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]
    const primary = String(command?.pattern || command?.cmdname || '').toLowerCase().trim()
    if (primary && seen.has(primary)) {
      commands.splice(index, 1)
      removedCommands += 1
      continue
    }
    if (primary) seen.add(primary)

    if (!Array.isArray(command?.alias)) continue
    command.alias = command.alias.filter(alias => {
      const normalized = String(alias || '').toLowerCase().trim()
      if (!normalized || normalized === primary || seen.has(normalized)) {
        removedAliases += 1
        return false
      }
      seen.add(normalized)
      return true
    })
  }

  return { removedCommands, removedAliases }
}

removeCommands(BROKEN_COMMANDS)

function socketFor(message) {
  return message?.bot || message?.client || global.__saffulLatestSocket
}

async function send(message, content, options = {}) {
  const socket = socketFor(message)
  if (typeof socket?.sendMessage !== 'function') throw new Error('WhatsApp socket is unavailable')
  return socket.sendMessage(message.chat, content, { quoted: message, ...options })
}

function repliedMessage(message) {
  return message?.quoted || message?.reply_message || message?.replyMessage || message
}

async function mediaBuffer(message) {
  const candidates = [repliedMessage(message), message]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (Buffer.isBuffer(candidate)) return candidate
    if (Buffer.isBuffer(candidate?.buffer)) return candidate.buffer
    for (const method of ['download', 'downloadMedia', 'downloadMediaMessage']) {
      if (typeof candidate?.[method] !== 'function') continue
      try {
        const result = await candidate[method]()
        if (Buffer.isBuffer(result)) return result
        if (typeof result === 'string' && fs.existsSync(result)) return fs.readFileSync(result)
      } catch {}
    }
  }
  throw new Error('Reply to an image, video, audio, or sticker first.')
}

function mediaType(message) {
  const quoted = repliedMessage(message)
  return String(quoted?.mtype || quoted?.type || quoted?.mimetype || message?.mtype || '').toLowerCase()
}

function mediaExtension(message, fallback = 'mp4') {
  const type = mediaType(message)
  if (type.includes('webp') || type.includes('sticker')) return 'webp'
  if (type.includes('png')) return 'png'
  if (type.includes('jpeg') || type.includes('jpg') || type.includes('image')) return 'jpg'
  if (type.includes('ogg') || type.includes('opus')) return 'ogg'
  if (type.includes('mpeg') || type.includes('mp3') || type.includes('audio')) return 'mp3'
  if (type.includes('webm')) return 'webm'
  return fallback
}

function asBuffer(result) {
  if (Buffer.isBuffer(result)) return result
  if (typeof result === 'string' && fs.existsSync(result)) return fs.readFileSync(result)
  if (Buffer.isBuffer(result?.data)) return result.data
  throw new Error('Media conversion produced no output.')
}

function cleanup(file) {
  try { if (typeof file === 'string' && fs.existsSync(file)) fs.unlinkSync(file) } catch {}
}

async function stickerPath(buffer, message, metadata = {}) {
  const options = {
    packname: metadata.packname || process.env.STICKER_PACK || 'SAFFUL-MD',
    author: metadata.author || process.env.STICKER_AUTHOR || 'Safful Tech',
  }
  const type = mediaType(message)
  if (type.includes('video')) return exif.writeExifVid(buffer, options)
  if (type.includes('sticker') || type.includes('webp')) return exif.writeExifWebp(buffer, options)
  return exif.writeExifImg(buffer, options)
}

async function sendSticker(message, buffer, metadata) {
  const file = await stickerPath(buffer, message, metadata)
  try {
    return await send(message, { sticker: { url: file } })
  } finally {
    cleanup(file)
  }
}

replaceCommand({
  pattern: 'ping',
  alias: ['speed'],
  desc: 'Measure the live WhatsApp response time',
  category: 'general',
}, async message => {
  const started = process.hrtime.bigint()
  // Editing is not consistently supported for bot messages in recent
  // WhatsApp clients. Always send a separate result so the latency value is
  // visible instead of leaving the user at “Pinging…”.
  await message.reply('🏓 Pinging…')
  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6
  return message.reply(`🏓 *Pong!* ${Math.max(1, Math.round(milliseconds))} ms`)
})

const FUN = {
  question: [
    'What small decision changed your life more than expected?',
    'Which skill would you master instantly if you could?',
    'What is something you believed as a child for far too long?',
    'Which place makes you feel most at peace?',
    'What would your ideal ordinary day look like?',
    'What is a harmless hill you are willing to die on?',
    'Which invention do you think people take for granted?',
    'If you could relive one year, which would it be and why?',
    'What is the best advice you initially ignored?',
    'Which fictional world would be fun to visit but terrible to live in?',
    'What is one thing you want to learn this year?',
    'Which song always improves your mood?',
  ],
  truth: [
    'What is the last lie you told?',
    'Who was your first crush?',
    'What is your most embarrassing habit?',
    'What is something you have never admitted to your friends?',
    'What is the pettiest reason you have stopped talking to someone?',
    'What is the strangest thing in your search history?',
    'When did you last pretend to understand something?',
    'What is the biggest promise you have broken?',
    'Which person here would you trust with your biggest secret?',
    'What is your most irrational fear?',
    'What is the worst excuse you have used to avoid plans?',
    'What is one opinion you changed completely?',
    'Have you ever blamed someone else for your mistake?',
    'What is your guiltiest pleasure?',
    'What is something you wish people understood about you?',
    'What is the boldest message you sent and regretted?',
    'Which compliment do you still remember?',
    'What is the most childish thing you still do?',
    'What secret talent do you rarely show?',
    'What is one thing you would change about your last relationship?',
  ],
  dare: [
    'Send a voice note singing the chorus of the last song you played.',
    'Use only emojis for your next three messages.',
    'Change your profile picture to a funny selfie for 10 minutes.',
    'Compliment the last person who messaged in this chat.',
    'Write a dramatic goodbye speech and return one minute later.',
    'Send the fifth photo in your gallery without explaining it.',
    'Talk like a movie villain for the next five minutes.',
    'Let the group choose your status for 15 minutes.',
    'Send a voice note doing your best celebrity impression.',
    'Type your name using your elbow and send the result.',
    'Tell the group a genuinely terrible joke.',
    'Describe your day as if it were a sports commentary.',
    'Message a friend “I know what you did” and share their reply.',
    'Make up a two-line poem about the person above you.',
    'Speak only in questions for the next five minutes.',
    'Share an unpopular food opinion.',
    'Recreate your favorite emoji with your face.',
    'Send a motivational speech about doing the dishes.',
    'Let someone in the chat pick your next playlist song.',
    'Write a one-sentence autobiography.',
  ],
  joke: [
    'Why do programmers prefer dark mode? Because light attracts bugs.',
    'I told my computer I needed a break. It said: “No problem, I’ll go to sleep.”',
    'Why was the math book sad? It had too many problems.',
    'I only know 25 letters of the alphabet. I do not know y.',
    'Why did the scarecrow win an award? He was outstanding in his field.',
    'Parallel lines have so much in common. It is a shame they will never meet.',
    'What do you call fake spaghetti? An impasta.',
    'Why could the bicycle not stand up? It was two-tired.',
    'The future, the present, and the past walked into a bar. Things got tense.',
    'Why did the developer go broke? They used up all their cache.',
    'A SQL query walks into a bar, approaches two tables, and asks: “May I join you?”',
    'Why was the JavaScript developer sad? They did not Node how to Express themselves.',
    'I tried to catch fog yesterday. Mist.',
    'What is orange and sounds like a parrot? A carrot.',
    'Why do cows wear bells? Because their horns do not work.',
  ],
  fact: [
    'Octopuses have three hearts and blue blood.',
    'A day on Venus is longer than a year on Venus.',
    'Bananas are berries, while strawberries are not botanical berries.',
    'Honey can remain edible for thousands of years when sealed properly.',
    'Sharks existed before trees appeared on Earth.',
    'The Eiffel Tower can grow about 15 cm taller in hot weather.',
    'Wombat droppings are cube-shaped.',
    'The human body contains enough iron to make a small nail.',
    'Some turtles can breathe through specialized tissue near their rear end.',
    'A group of flamingos is called a flamboyance.',
    'The Moon moves about 3.8 cm farther from Earth each year.',
    'Water can boil and freeze at the same time at its triple point.',
    'The shortest recorded war lasted less than an hour.',
    'Sea otters sometimes hold hands while sleeping so they do not drift apart.',
    'An average cumulus cloud can weigh hundreds of tonnes.',
    'The dot above a lowercase i or j is called a tittle.',
    'Koala fingerprints are remarkably similar to human fingerprints.',
    'There are more possible chess games than atoms in the observable universe.',
  ],
  quotes: [
    '“The secret of getting ahead is getting started.” — Mark Twain',
    '“It always seems impossible until it is done.” — Nelson Mandela',
    '“Simplicity is the ultimate sophistication.” — Leonardo da Vinci',
    '“What we think, we become.” — often attributed to the Buddha',
    '“Well done is better than well said.” — Benjamin Franklin',
    '“You miss 100% of the shots you do not take.” — Wayne Gretzky',
    '“The only way out is through.” — Robert Frost',
    '“Action is the foundational key to all success.” — Pablo Picasso',
    '“If you want to go fast, go alone. If you want to go far, go together.” — proverb',
    '“Success is the sum of small efforts, repeated day in and day out.” — Robert Collier',
    '“Do what you can, with what you have, where you are.” — Theodore Roosevelt',
    '“A year from now you may wish you had started today.” — Karen Lamb',
    '“The best way to predict the future is to create it.” — Peter Drucker',
    '“Courage is grace under pressure.” — Ernest Hemingway',
    '“No act of kindness, no matter how small, is ever wasted.” — Aesop',
  ],
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)]
}

for (const [pattern, items] of Object.entries(FUN)) {
  const aliases = pattern === 'joke' ? ['joke2'] : []
  replaceCommand({ pattern, alias: aliases, desc: `Get a random ${pattern}`, category: 'fun' }, async message => {
    return message.reply(randomItem(items))
  })
}

replaceCommand({ pattern: 'define', desc: 'Look up an English word', category: 'fun', use: '<word>' }, async (message, text) => {
  const word = String(text || repliedMessage(message)?.text || '').trim().split(/\s+/)[0]
  if (!word) return message.reply('Usage: `.define <word>`')
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return message.reply(`No definition found for *${word}*.`)
    const entries = await response.json()
    const entry = entries?.[0]
    const meanings = (entry?.meanings || []).slice(0, 3).map(meaning => {
      const definition = meaning?.definitions?.[0]?.definition
      return definition ? `• *${meaning.partOfSpeech || 'meaning'}:* ${definition}` : ''
    }).filter(Boolean)
    if (!meanings.length) return message.reply(`No definition found for *${word}*.`)
    return message.reply(`📖 *${entry.word || word}*\n${meanings.join('\n')}`)
  } catch {
    return message.reply('The dictionary service is temporarily unavailable.')
  }
})

replaceCommand({ pattern: 'ebinary', desc: 'Encode text as binary', category: 'converter', use: '<text>' }, async (message, text) => {
  const input = String(text || '').trim()
  if (!input) return message.reply('Usage: `.ebinary <text>`')
  const encoded = Array.from(Buffer.from(input, 'utf8'), byte => byte.toString(2).padStart(8, '0')).join(' ')
  return message.reply(encoded)
})

replaceCommand({ pattern: 'dbinary', desc: 'Decode binary text', category: 'converter', use: '<binary>' }, async (message, text) => {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact || /[^01]/.test(compact) || compact.length % 8 !== 0) {
    return message.reply('Use groups of 8 binary digits, for example: `.dbinary 01001000 01101001`')
  }
  const bytes = compact.match(/.{8}/g).map(value => parseInt(value, 2))
  return message.reply(Buffer.from(bytes).toString('utf8'))
})

replaceCommand({ pattern: 'fancy', alias: ['fancytext'], desc: 'Show text in multiple styles', category: 'converter', use: '<text>' }, async (message, text) => {
  const input = String(text || '').trim()
  if (!input) return message.reply('Usage: `.fancy <text>`')
  const styles = stylish.listall(input)
  return message.reply(styles.slice(0, 30).map((value, index) => `${index + 1}. ${value}`).join('\n'))
})

replaceCommand({ pattern: 'styly', alias: ['randomstyle'], desc: 'Apply a random text style', category: 'converter', use: '<text>' }, async (message, text) => {
  const input = String(text || '').trim()
  return input ? message.reply(stylish.randomStyle(input)) : message.reply('Usage: `.styly <text>`')
})

replaceCommand({ pattern: 'tiny', desc: 'Convert text to tiny letters', category: 'converter', use: '<text>' }, async (message, text) => {
  const input = String(text || '').trim()
  return input ? message.reply(stylish.tiny(input)) : message.reply('Usage: `.tiny <text>`')
})

replaceCommand({ pattern: 'fliptext', alias: ['flip'], desc: 'Flip text upside down', category: 'converter', use: '<text>' }, async (message, text) => {
  const input = String(text || '').trim()
  return input ? message.reply(stylish.flip(input)) : message.reply('Usage: `.fliptext <text>`')
})

replaceCommand({ pattern: 'qr', alias: ['qrcode', 'makeqr'], desc: 'Create a QR code', category: 'converter', use: '<text or link>' }, async (message, text) => {
  const input = String(text || repliedMessage(message)?.text || '').trim()
  if (!input) return message.reply('Usage: `.qr <text or link>`')
  if (input.length > 2000) return message.reply('That text is too long for a useful QR code.')
  const image = await qrcode.toBuffer(input, { width: 512, margin: 2, errorCorrectionLevel: 'M' })
  return send(message, { image, caption: '🔳 QR code created.' })
})

replaceCommand({ pattern: 'sticker', alias: ['s'], desc: 'Turn an image or short video into a sticker', category: 'sticker' }, async message => {
  try {
    return await sendSticker(message, await mediaBuffer(message))
  } catch (error) {
    return message.reply(error?.message || 'Sticker conversion failed.')
  }
})

replaceCommand({ pattern: 'take', alias: ['steal'], desc: 'Change a sticker pack name and author', category: 'sticker', use: '<pack|author>' }, async (message, text) => {
  try {
    const [packname, author] = String(text || '').split('|').map(value => value.trim())
    return await sendSticker(message, await mediaBuffer(message), {
      packname: packname || 'SAFFUL-MD',
      author: author || 'Safful Tech',
    })
  } catch (error) {
    return message.reply(error?.message || 'Could not update that sticker.')
  }
})

async function transformedSticker(message, transform) {
  try {
    const input = await mediaBuffer(message)
    const output = await transform(sharp(input, { animated: false }).rotate())
    return await sendSticker(message, output)
  } catch (error) {
    return message.reply(error?.message || 'Sticker conversion failed.')
  }
}

replaceCommand({ pattern: 'crop', alias: ['cropsticker'], desc: 'Crop an image into a square sticker', category: 'sticker' }, message => {
  return transformedSticker(message, image => image.resize(512, 512, { fit: 'cover' }).png().toBuffer())
})

replaceCommand({ pattern: 'circle', alias: ['circlestic', 'circlesticker', 'cs'], desc: 'Create a circular sticker', category: 'sticker' }, message => {
  const mask = Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="256" fill="white"/></svg>')
  return transformedSticker(message, image => image.resize(512, 512, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer())
})

replaceCommand({ pattern: 'round', alias: ['roundstic', 'roundsticker'], desc: 'Create a rounded-corner sticker', category: 'sticker' }, message => {
  const mask = Buffer.from('<svg width="512" height="512"><rect width="512" height="512" rx="80" ry="80" fill="white"/></svg>')
  return transformedSticker(message, image => image.resize(512, 512, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer())
})

replaceCommand({ pattern: 'photo', alias: ['toimg'], desc: 'Turn a sticker into an image', category: 'converter' }, async message => {
  try {
    const image = await sharp(await mediaBuffer(message), { animated: false }).png().toBuffer()
    return await send(message, { image, caption: '🖼️ Converted from sticker.' })
  } catch (error) {
    return message.reply(error?.message || 'Image conversion failed.')
  }
})

replaceCommand({ pattern: 'toaudio', alias: ['tomp3'], desc: 'Convert replied media to MP3', category: 'converter' }, async message => {
  try {
    const output = await mediaTools.toAudio(await mediaBuffer(message), mediaExtension(message))
    return await send(message, { audio: asBuffer(output), mimetype: 'audio/mpeg' })
  } catch (error) {
    return message.reply(`Audio conversion failed: ${error?.message || error}`)
  }
})

replaceCommand({ pattern: 'voice', alias: ['ptt', 'toptt'], desc: 'Convert replied media to a voice note', category: 'converter' }, async message => {
  try {
    const output = await mediaTools.toPTT(await mediaBuffer(message), mediaExtension(message))
    return await send(message, { audio: asBuffer(output), mimetype: 'audio/ogg; codecs=opus', ptt: true })
  } catch (error) {
    return message.reply(`Voice-note conversion failed: ${error?.message || error}`)
  }
})

replaceCommand({ pattern: 'tomp4', alias: ['mp4', 'tovideo'], desc: 'Convert a sticker or GIF to MP4', category: 'converter' }, async message => {
  try {
    const output = await mediaTools.toVideo(await mediaBuffer(message), mediaExtension(message, 'webp'))
    return await send(message, { video: asBuffer(output), mimetype: 'video/mp4' })
  } catch (error) {
    return message.reply(`Video conversion failed: ${error?.message || error}`)
  }
})

function instagramUrl(text) {
  return String(text || '').match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s]+/i)?.[0] || ''
}

async function fetchMedia(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131 Safari/537.36' },
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) throw new Error(`Media server returned ${response.status}`)
  const length = Number(response.headers.get('content-length') || 0)
  if (length > 64 * 1024 * 1024) throw new Error('Media is larger than 64 MB')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('Downloaded media was empty')
  return buffer
}

async function sendInstagramItems(message, result) {
  const items = (result?.medias || []).filter(item => item?.url).slice(0, 10)
  if (!items.length) return false
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    const buffer = await fetchMedia(item.url)
    const kind = String(item.type || item.extension || '').toLowerCase()
    const caption = index === 0
      ? `📸 *Instagram Download*${result?.author ? `\n👤 ${result.author}` : ''}${items.length > 1 ? `\n📦 ${items.length} items` : ''}`
      : ''
    if (/photo|image|jpe?g|png|webp/.test(kind)) await send(message, { image: buffer, caption })
    else await send(message, { video: buffer, caption, mimetype: 'video/mp4' })
  }
  return true
}

replaceCommand({ pattern: 'ig', alias: ['igdl', 'instagram'], desc: 'Download Instagram videos, reels, and pictures', category: 'downloader', use: '<Instagram URL>' }, async (message, text) => {
  const url = instagramUrl(text) || instagramUrl(repliedMessage(message)?.text)
  if (!url) return message.reply('Usage: `.ig <Instagram post, reel, or picture URL>`')
  await message.reply('⏳ Downloading from Instagram…')
  try {
    try {
      const result = await social.downloadViaRapidAPI(url)
      if (await sendInstagramItems(message, result)) return
    } catch (error) {
      process.stdout.write(`[ig] carousel API unavailable: ${error?.message || error}\n`)
    }

    const fallback = await social.download(url, { caption: '📸 *Instagram Download*' })
    if (!fallback?.success || !fallback?.buffer) throw new Error(fallback?.error || 'No downloadable media found')
    const extension = path.extname(fallback.filename || '').toLowerCase()
    if (/\.(jpg|jpeg|png|webp)$/.test(extension)) return send(message, { image: fallback.buffer, caption: fallback.caption })
    return send(message, { video: fallback.buffer, caption: fallback.caption, mimetype: 'video/mp4' })
  } catch (error) {
    return message.reply(`Instagram download failed: ${error?.message || error}`)
  }
})

process.stdout.write(`[commands] Reliability replacements loaded; ${BROKEN_COMMANDS.size} obsolete commands removed.\n`)

module.exports = {
  BROKEN_COMMANDS,
  FUN,
  mediaBuffer,
  namesOf,
  removeCommands,
  deduplicateCommands,
}
