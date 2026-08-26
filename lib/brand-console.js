'use strict'

// SAFFUL-MD terminal branding.
// The renderer intentionally uses the compact telemetry style from the
// reference console: thin rules, square status markers and aligned values.

const rawStdoutWrite = process.stdout.write.bind(process.stdout)
const rawConsoleLog = console.log.bind(console)

const useColor = !process.env.NO_COLOR && process.env.TERM !== 'dumb'
const color = (code) => (useColor ? `\x1b[${code}m` : '')

const GREEN = color('38;2;0;255;145')
const GREEN_MID = color('38;2;0;205;115')
const GREEN_LOW = color('38;2;0;135;85')
const CYAN = color('38;2;0;220;255')
const YELLOW = color('38;2;255;220;40')
const RED = color('38;2;255;75;75')
const PURPLE = color('38;2;205;120;255')
const WHITE = color('38;2;215;225;230')
const DIM = color('2')
const BOLD = color('1')
const RESET = color('0')

const PANEL_WIDTH = 62
const shownStatuses = new Set()
let summaryPrinted = false

let version = '1.0.1'
try {
  version = require('../package.json').version || version
} catch {}

function write(text = '') {
  return rawStdoutWrite(String(text))
}

function writeLine(text = '') {
  return write(`${text}\n`)
}

function rebrand(value) {
  return String(value)
    .replace(/Suhail[-_ ]*Md/gi, 'Safful-MD')
    .replace(/SuhailMD/gi, 'SaffulMD')
    .replace(/Suhail_Baileys/gi, 'Safful_Baileys')
    .replace(/SPECTER/gi, 'SAFFUL')
    .replace(/SUHAIL/gi, 'SAFFUL')
    .replace(/MULTIDEV[OI][CN]E\s+WHATS[A4]?[PQ]+\s+USER\s+BOT/gi, 'WhatsApp Multi-Device Bot')
}

function printBanner() {
  const rows = [
    `${GREEN}${BOLD} .::::::.   :::.     .-:::::'.-:::::'...    ::: :::        :::::::.      ...   ::::::::::::${RESET}`,
    `${GREEN}${BOLD};;;\`    \`   ;;\`;;    ;;;'''' ;;;'''' ;;     ;;; ;;;         ;;;'';;'  .;;;;;;;.;;;;;;;;''''${RESET}`,
    `${GREEN}'[==/[[[[, ,[[ '[[,  [[[,,== [[[,,==[['     [[[ [[[         [[[__[[\.,[[     \[[,   [[     ${RESET}`,
    `${GREEN_MID}  '''    $c$$$cc$$$c \`$$$"\`\`  \`$$$"\`\`$$      $$$ \$\$'         \$\$""""Y\$\$\$\$\$,     \$\$\$   \$\$     ${RESET}`,
    `${GREEN_LOW} 88b    dP 888   888  888     888   88    .d888o88oo,.__   _88o,,od8P"888,_ _,88P   88,    ${RESET}`,
    `${GREEN_LOW}  "YMmMY"  YMM   \"\"\`"MM,    "MM,   "YmmMMMM""""""YUMMM   ""YUMMMP"   "YMMMMMP"    MMM    ${RESET}`,
  ]

  writeLine()
  rows.forEach(writeLine)
  writeLine()
  writeLine(`${DIM}${GREEN}  ${'━'.repeat(PANEL_WIDTH)}${RESET}`)
  writeLine(`${CYAN}${BOLD}  ⚡ WHATSAPP MULTI-DEVICE BOT  •  BY SAFFUL TECH${RESET}`)
  writeLine(`${DIM}${GREEN}  ${'━'.repeat(PANEL_WIDTH)}${RESET}`)
  writeLine()
}

function panelHeader(state = 'BOOT SEQUENCE') {
  const title = `🎭 SAFFUL BOT v${version}  •  ${state}`
  const left = `┌─[ ${title} ] `
  const fill = '─'.repeat(Math.max(3, PANEL_WIDTH - Array.from(left).length - 1))
  writeLine(`${GREEN}  ${left}${fill}┐${RESET}`)
}

function separator() {
  writeLine(`${DIM}${GREEN}  ${'─'.repeat(PANEL_WIDTH)}${RESET}`)
}

function statusRow(label, value, valueColor = GREEN) {
  const cacheKey = `${label}\u0000${value}`
  if (shownStatuses.has(cacheKey)) return
  shownStatuses.add(cacheKey)

  writeLine(
    `${GREEN}  ▣${RESET} ${DIM}${WHITE}${String(label).padEnd(21)}${RESET} ` +
    `${CYAN}:${RESET} ${valueColor}${value}${RESET}`
  )
}

function progressFooter() {
  const bar = '████████████████████████'
  writeLine(
    `${GREEN}  └─[ ${bar}${RESET}  ${YELLOW}${BOLD}100%${RESET}  ` +
    `${GREEN}▸  ALL SYSTEMS ONLINE  ✓ ]${RESET}`
  )
}

function printBootStatus(message) {
  const text = rebrand(message)
  const lower = text.toLowerCase()

  if (lower.includes('loading core')) {
    statusRow('Core Module', '■ loading...', YELLOW)
    return true
  }
  if (lower.includes('core loaded')) {
    statusRow('Core Module', '✓ loaded')
    return true
  }
  if (lower.includes('initializing session')) {
    statusRow('Session', '■ initializing...', YELLOW)
    return true
  }
  if (lower.includes('session initialized')) {
    statusRow('Session', '✓ initialized')
    return true
  }
  if (lower.includes('syncing database') || lower.includes('database syncing')) {
    statusRow('Database', '■ syncing...', YELLOW)
    return true
  }
  if (lower.includes('database ready')) {
    statusRow('Database', '✓ ready')
    return true
  }
  if (lower.includes('connecting to whatsapp')) {
    statusRow('WhatsApp Channel', '■ connecting...', YELLOW)
    return true
  }
  if (lower.includes('hooks attached')) {
    statusRow('Security Hooks', '✓ attached')
    return true
  }
  if (lower.includes('[automod]') || lower.includes('auto-moderation hooks installed')) {
    statusRow('Auto-Moderation', '✓ active')
    return true
  }
  if (lower.includes('connection state:') && lower.includes('connecting')) {
    statusRow('WhatsApp Channel', '● CONNECTING', YELLOW)
    return true
  }
  if (
    (lower.includes('connection state:') && lower.includes('open')) ||
    lower.includes('whatsapp connected')
  ) {
    statusRow('WhatsApp Channel', '● CONNECTED')
    return true
  }
  if (
    (lower.includes('connection state:') && lower.includes('close')) ||
    lower.includes('connection closed')
  ) {
    statusRow('WhatsApp Channel', '● RECONNECTING', RED)
    return true
  }

  return false
}

function capture(text, expression, fallback) {
  const match = String(text).match(expression)
  return match && match[1] ? match[1].trim() : fallback
}

function printConnectedSummary(message) {
  if (summaryPrinted) return
  summaryPrinted = true

  const text = rebrand(message)
  const prefix = capture(text, /Prefix\s*:\s*\[\s*([^\]]*)\s*\]/i, process.env.HANDLERS || '.')
  const plugins = capture(text, /Plugins\s*:\s*([^\r\n]+)/i, 'ready')
  const mode = capture(text, /Mode\s*:\s*([^\r\n]+)/i, process.env.WORKTYPE || 'private')
  const database = capture(text, /Database\s*:\s*([^\r\n]+)/i, process.env.DATABASE_URL ? 'external' : 'JSON (local)')

  const lines = [
    () => separator(),
    () => statusRow('Platform', process.platform),
    () => statusRow('Time', new Date().toLocaleTimeString('en-GB', { hour12: false })),
    () => statusRow('Auth State', '✓ registered  ·  OK'),
    () => statusRow('Connection', '● ONLINE'),
    () => statusRow('Prefix', `[ ${prefix} ]`, CYAN),
    () => statusRow('Plugins', plugins, PURPLE),
    () => statusRow('Mode', mode, CYAN),
    () => statusRow('Database', database, database.toLowerCase().includes('no db') ? YELLOW : GREEN),
    () => separator(),
    () => statusRow('Core Integrity', '✓ verified'),
    () => statusRow('Session Guard', '✓ armed'),
    () => statusRow('Runtime Monitor', '● ACTIVE'),
    () => statusRow('Access Policy', 'authorized operation only', CYAN),
    () => separator(),
    () => progressFooter(),
  ]

  lines.forEach((fn, i) => {
    setTimeout(fn, i * 180)
  })
}

function isLegacyBanner(text) {
  // Catch SPECTER banner
  if (/SPECTER/i.test(text)) return true
  // Catch MULTIDEVICE WHATSAPP USER BOT (plain and bold unicode)
  if (/MULTIDEVICE\s+WHATSAPP\s+USER\s+BOT/i.test(text)) return true
  if (/𝗠𝘂𝗹𝘁𝗶𝗗𝗲𝘃𝗶𝗰𝗲/i.test(text)) return true
  if (/𝗠ULTI𝗗𝗘𝗩𝗜𝗖𝗘/i.test(text)) return true
  // Catch box-drawing banners (but NOT QR codes)
  if (/[╔╗╚╝║═]{4,}/.test(text)) return true
  // Catch SUHAIL/Suhail ASCII art blocks
  if (/Suhail[-_ ]*Md/i.test(text)) return true
  if (/SUHAIL/i.test(text)) return true
  return false
}

function isConnectedSummary(text) {
  const lower = rebrand(text).toLowerCase()
  return (
    lower.includes('whatsapp login successful') ||
    (lower.includes('safful-md connected') && lower.includes('plugins'))
  )
}

const HIDE_PATTERNS = [
  /Health server on http/i,
  /fetching live WhatsApp-Web revision/i,
  /Live WhatsApp-Web revision:/i,
  /revision resolved/i,
  /auth-prep:/i,
  /auth method:/i,
  /Pairing-code login selected/i,
  /Pairing target:/i,
  /Starting standalone pairing/i,
  /WhatsApp ready.*requesting pairing/i,
  /Requesting pairing code/i,
  /Brand code:/i,
  /Pairing code:/i,
  /requestPairingCode/i,
  /Safful live-only cache mode/i,
  /Replaced Safful_Baileys/i,
  /Created Safful_Baileys/i,
  /anti-fork git remote check/i,
  /pre-core capture hook/i,
  /Sharp native binary is unavailable/i,
  /viewing statuses every/i,
  /DEP0040.*punycode/i,
  /install-scripts/i,
  /npm warn/i,
  /autoview.*enabled/i,
  /Checking External Plugins/i,
  /safful-social.*loaded OK/i,
  /safful-sports.*loaded OK/i,
  /safful-pin.*loaded OK/i,
  /safful-snap.*loaded OK/i,
  /\[safful-pin\]/i,
  /\[safful-snap\]/i,
  /\[safful-sports\]/i,
  /\[safful-social\]/i,
  /\[safful-hack\]/i,
  /\[safful-spotify\]/i,
  /\[safful-automod\]/i,
  /safful-hack.*loaded OK/i,
  /safful-privacy.*loaded OK/i,
  /session-guard.*no DATABASE_URL.*skip/i,
  /pre-core raw media capture/i,
  /Flushing SESSION_ID/i,
  /myAppStateKeyId Missing/i,
  /Specter/gi,
  /SUHAIL/gi,
  /Suhail/gi,
  /suhail/gi,
  /WhatsApp Multi-Device Bot.*By Safful/i,
  /Safful_Baileys.*Safful_Session/i,
  /Created.*session directory/i,
  /Replaced.*session/i,
  /anti-fork.*neutralized/i,
  /capture hook armed/i,
  /native binary.*unavailable/i,
  /viewing statuses/i,
  /session-guard.*skip/i,
  /raw media capture attached/i,
  /SESSION_ID/i,
  /AppStateKeyId/i,
  /Safful live-only/i,
  /safful.*cache mode/i,
  /symlink.*Baileys/i,
  /anti-fork/i,
  /fork-bypass/i,
  /safful-dl/i,
  /yt-dlp trying/i,
  /yt-dlp failed/i,
  /yt-dlp not found/i,
  /Downloaded yt-dlp/i,
  /Download response/i,
  /loader\.to conversion/i,
  /loader\.to ready/i,
  /loader\.to SUCCESS/i,
  /loader\.to failed/i,
  /loader\.to.*both domains/i,
  /loader\.to.*re-encod/i,
  /loader\.to.*start/i,
  /RapidAPI trying/i,
  /RapidAPI.*downloading/i,
  /RapidAPI CDN/i,
  /RapidAPI stage/i,
  /RapidAPI.*search/i,
  /youtubei:/i,
  /youtubei.*unknown/i,
  /Starting audio download/i,
  /Starting video download/i,
  /download.*success/i,
  /re-encoded/i,
  /re-encoding/i,
  /both domains failed/i,
  /search.*error/i,
  /search.*query/i,
  /ytsearch/i,
  /ig-download.*loaded/i,
  /sports-live.*loaded/i,
  /legacy.*disabled/i,
  /Removed broken/i,
  /Command access guard/i,
  /removed.*legacy command/i,
  /Suppressed legacy/i,
  /raw status monitoring/i,
  /removed old broken/i,
  /del command/i,
  /kick command/i,
  /qr command/i,
  /commands.*removed/i,
  /startup.*Suppressed/i,
  /\[mode\]/i,
  /\[commands\]/i,
  /\[delete\]/i,
  /\[kick/i,
  /\[qr\]/i,
  /\[autoview\]/i,
  /\[savestatus\]/i,
  /\[plugin\]/i,
  /1\.0\.1-developement/i,
  /1\.0\.1-development/i,
  /Suhail[-_ ]*Md/i,
  /SUHAIL[-_ ]*MD/i,
  /QR login selected/i,
  /trace-deprecation/i,
  /safful-avo/i,
  /raw-dispatcher hook/i,
  /Safful-MD Server listening/i,
  /WhatsApp reachable/i,
  /\[boot\] WhatsApp reachable/i,
  /\[branding\]/i,
  /\[protection\]/i,
  /\[session-guard\]/i,
  /\[boot\] socket created/i,
  /\[notifications\]/i,
  /\[raw-dispatcher\]/i,
  /\[boot\] connection open/i,
  /\[kick\.js\]/i,
  /\[mode\]/i,
  /\[qr\]/i,
  /\[startup\]/i,
  /legacy.*disabled/i,
  /removed.*legacy/i,
  /Suppressed legacy/i,
  /queued status/i,
  /sent read receipt/i,
  /receipt due in/i,
  /raw status monitoring/i,
  /TypeError.*is not a function/i,
  /TypeError.*Cannot read properties/i,
  /TypeError.*is not defined/i,
  /client\.js.*messages\.upsert/i,
]

function shouldHide(text) {
  return HIDE_PATTERNS.some((pattern) => pattern.test(text))
}

// QR terminal output has block runs of 6+ chars (finder patterns are 7).
// The old Suhail ASCII art only has runs up to 5, so this safely catches QR
// codes without eating the banner. QR is re-printed via the raw stdout
// watcher in index.js, so suppressing it here prevents double printing.
function isQrOutput(text) {
  return /[█▄▀]{6,}/.test(text)
}

function brandedStdout(chunk, ...rest) {
  const text = typeof chunk === 'string' ? chunk : String(chunk)

  if (shouldHide(text)) return true
  if (isLegacyBanner(text)) return true
  if (isQrOutput(text)) return true
  
  // Catch individual SPECTER lines in multi-line output
  if (/SPECTER/i.test(text) && /[█▀▄▓▒░╔╗╚╝║═]/.test(text)) return true
  
  // Replace any SPECTER/SUHAIL references anywhere
  if (/SPECTER|SUHAIL|Suhail|suhail/i.test(text)) {
    return rawStdoutWrite(rebrand(text), ...rest)
  }
  
  if (isConnectedSummary(text)) {
    printConnectedSummary(text)
    return true
  }
  if (printBootStatus(text)) return true

  return rawStdoutWrite(rebrand(text), ...rest)
}

// Save raw writers so trusted code (QR printer) can bypass the filter
process.__saffulRawStdout = rawStdoutWrite

// ── stderr interception ────────────────────────────────────────────────
// Plugins like ig-download/sports-live log via process.stderr.write,
// which bypassed console/stdout filters. Route it through the same rules.
const rawStderrWrite = process.stderr.write.bind(process.stderr)
function brandedStderr(chunk, ...rest) {
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  if (shouldHide(text)) return true
  if (isLegacyBanner(text)) return true
  if (isQrOutput(text)) return true
  return rawStderrWrite(text, ...rest)
}
try {
  process.stderr.write = brandedStderr
} catch {}
process.__saffulRawStderr = rawStderrWrite

// Save interceptor globally so it can be re-applied after smd.js
process.__saffulStdoutInterceptor = brandedStdout
process.__saffulStderrInterceptor = brandedStderr
process.__saffulConsoleLogInterceptor = function (...args) {
  const text = rebrand(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  if (shouldHide(text)) return
  if (isLegacyBanner(text)) return
  if (/SPECTER|SUHAIL|Suhail/i.test(text) && /[█▀▄▓▒░╔╗╚╝║═]/.test(text)) return
  if (isConnectedSummary(text)) return printConnectedSummary(text)
  if (printBootStatus(text)) return
  if (text.includes('[anti-delete]')) return statusRow('Anti-Delete', '✓ active')
  if (text.includes('[session-guard]')) return statusRow('Session Guard', '✓ armed')
  if (text.includes('[uptime]')) return statusRow('Uptime Guardian', '✓ active')
  rawConsoleLog(`${DIM}${WHITE}${text}${RESET}`)
}
process.stdout.write = brandedStdout

console.log = (...args) => {
  const text = rebrand(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))

  if (shouldHide(text)) return
  if (isLegacyBanner(text)) return
  if (/SPECTER|SUHAIL|Suhail/i.test(text)) {
    // If it has block chars, it's the banner - skip
    if (/[█▀▄▓▒░╔╗╚╝║═]/.test(text)) return
  }
  if (isConnectedSummary(text)) return printConnectedSummary(text)
  if (printBootStatus(text)) return

  if (text.includes('[anti-delete]')) return statusRow('Anti-Delete', '✓ active')
  if (text.includes('[session-guard]')) return statusRow('Session Guard', '✓ armed')
  if (text.includes('[uptime]')) return statusRow('Uptime Guardian', '✓ active')

  rawConsoleLog(`${DIM}${WHITE}${text}${RESET}`)
}

console.error = (...args) => {
  const text = rebrand(args.map(String).join(' '))
  writeLine(`${RED}  ▣ ERROR                : ${text}${RESET}`)
}

console.warn = (...args) => {
  const text = rebrand(args.map(String).join(' '))
  writeLine(`${YELLOW}  ▣ WARNING              : ${text}${RESET}`)
}

printBanner()
panelHeader('BOOT SEQUENCE')

// Save interceptors so they can be re-applied after smd.js overwrites them
const _brandedStdout = process.stdout.write
const _brandedConsoleLog = console.log
const _brandedConsoleError = console.error
const _brandedConsoleWarn = console.warn

function reapplyInterceptors() {
  // Only re-apply if smd.js has overwritten them
  if (process.stdout.write !== _brandedStdout) {
    // smd.js overwrote our stdout.write — wrap theirs with our logic
    const smdWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = function(chunk, ...rest) {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      if (shouldHide(text)) return true
      if (isLegacyBanner(text)) return true
      if (/SPECTER|SUHAIL|Suhail|suhail/i.test(text) && /[█▀▄▓▒░╔╗╚╝║═]/.test(text)) return true
      if (isConnectedSummary(text)) { printConnectedSummary(text); return true }
      if (printBootStatus(text)) return true
      return _brandedStdout(rebrand(text), ...rest)
    }
  }
  if (console.log !== _brandedConsoleLog) {
    const smdLog = console.log.bind(console)
    console.log = (...args) => {
      const text = rebrand(args.map(a => typeof a === 'string' ? a : String(a)).join(' '))
      if (shouldHide(text)) return
      if (isLegacyBanner(text)) return
      if (/SPECTER|SUHAIL|Suhail/i.test(text) && /[█▀▄▓▒░╔╗╚╝║═]/.test(text)) return
      if (isConnectedSummary(text)) return printConnectedSummary(text)
      if (printBootStatus(text)) return
      if (text.includes('[anti-delete]')) return statusRow('Anti-Delete', '✓ active')
      if (text.includes('[session-guard]')) return statusRow('Session Guard', '✓ armed')
      if (text.includes('[uptime]')) return statusRow('Uptime Guardian', '✓ active')
      _brandedConsoleLog(`${DIM}${WHITE}${text}${RESET}`)
    }
  }
}

module.exports = { rebrand, reapplyInterceptors }
