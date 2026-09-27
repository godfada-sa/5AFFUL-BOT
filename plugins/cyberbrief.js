'use strict'

// Defensive scam/phishing triage. This intentionally performs no probing,
// scanning, credential collection, or intrusion activity.
const { cmd } = require('../lib/plugins')

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'cutt.ly', 'rebrand.ly', 'tiny.cc', 'rb.gy'])
const TRUSTED_BRANDS = ['whatsapp', 'google', 'microsoft', 'apple', 'paypal', 'instagram', 'facebook', 'telegram', 'netflix', 'amazon', 'binance']
const RISK_WORDS = [
  ['urgent', 'urgency language'], ['immediately', 'urgency language'], ['verify your account', 'account-verification bait'],
  ['suspended', 'account-suspension bait'], ['gift card', 'gift-card payment request'], ['crypto', 'crypto-payment request'],
  ['password', 'credential request'], ['otp', 'one-time-password request'], ['code', 'security-code request'],
  ['click here', 'link-pressure wording'], ['limited time', 'artificial deadline'], ['winner', 'prize/lottery wording'],
]

function urlFrom(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>]+/i)
  return match ? match[0].replace(/[),.!?]+$/, '') : ''
}

function assess(input) {
  const text = String(input || '').trim()
  const signals = []
  let score = 0
  const add = (points, label) => { score += points; signals.push(label) }

  let host = ''
  const url = urlFrom(text)
  if (url) {
    try {
      const parsed = new URL(url)
      host = parsed.hostname.toLowerCase().replace(/^www\./, '')
      if (parsed.protocol !== 'https:') add(2, 'unencrypted HTTP link')
      if (SHORTENERS.has(host)) add(3, 'shortened link hides its destination')
      if (host.includes('xn--')) add(4, 'punycode/look-alike domain encoding')
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add(3, 'raw IP address used instead of a domain')
      if (host.split('.').length > 4) add(1, 'unusually deep subdomain')
      const brand = TRUSTED_BRANDS.find((name) => host.includes(name))
      if (brand && !new RegExp(`(^|\\.)${brand.replace('.', '\\.')}(\\.|$)`).test(host)) add(3, `possible ${brand} look-alike domain`)
    } catch {
      add(3, 'malformed or deceptive-looking URL')
    }
  }

  const lower = text.toLowerCase()
  for (const [term, label] of RISK_WORDS) if (lower.includes(term)) add(1, label)
  if (/\b(\d{4}[- ]?){3}\d{4}\b/.test(text)) add(2, 'possible card number present')
  if (/\+?\d{7,15}/.test(text) && /send|pay|transfer|deposit/i.test(text)) add(1, 'payment request paired with a phone number')

  const risk = score >= 6 ? 'HIGH' : score >= 3 ? 'NEEDS VERIFICATION' : 'LOW OBVIOUS RISK'
  return { risk, score, signals: [...new Set(signals)], host }
}

function report(input) {
  const result = assess(input)
  const lines = [
    '╭─〔 *SAFFUL // THREAT INTELLIGENCE* 〕',
    `│ Risk: *${result.risk}*`,
    `│ Target: ${result.host || 'forwarded text/message'}`,
    '├────────────────────',
  ]
  if (result.signals.length) {
    lines.push('│ Signals:')
    for (const signal of result.signals.slice(0, 6)) lines.push(`│ • ${signal}`)
  } else {
    lines.push('│ Signals: no obvious automated red flags found')
  }
  lines.push('├────────────────────')
  lines.push('│ Recommended action:')
  if (result.risk === 'HIGH') lines.push('│ Do not open it, sign in, pay, or share a code. Verify through the official app/site.')
  else if (result.risk === 'NEEDS VERIFICATION') lines.push('│ Verify the sender and open the official site manually—do not use the supplied link.')
  else lines.push('│ No obvious red flags. Still verify important claims using an official channel.')
  lines.push('╰─ _Automated triage only — not proof of authenticity._')
  return lines.join('\n')
}

cmd({
  pattern: 'cyberbrief',
  alias: ['threatbrief', 'linkcheck', 'scamcheck'],
  desc: 'Defensive phishing and scam triage for a link or forwarded text.',
  category: 'security',
  use: '.cyberbrief https://example.com',
  filename: __filename,
}, async (message, args) => {
  const input = String(args || '').trim() || String(message?.quoted?.text || message?.quoted?.body || '')
  if (!input) return message.reply('*Usage:* `.cyberbrief <link or message>`\nOr reply to a text message with `.cyberbrief`.')
  return message.reply(report(input))
})

module.exports = { assess, report }
