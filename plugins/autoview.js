'use strict'
// .autoview — control the status auto-view engine (plugins/statusauto.smd).
//   .autoview            → status card
//   .autoview on         → mark every status seen immediately
//   .autoview <1-10>     → mark statuses seen after a delay of N minutes
//   .autoview off        → stop marking statuses seen

const { cmd } = require('../lib/plugins')
const autoview = require('./statusauto.smd')
const { isOperator } = require('../lib/safful-identities')

function isOwner(message, extra) {
  return isOperator(message, extra, extra?.Void || message?.bot || global.__saffulLatestSocket)
}

cmd({
  pattern: 'autoview',
  alias: ['autoviewstatus', 'statusview'],
  desc: 'Auto-view statuses: instant, a 1-10 minute delay, or off',
  category: 'owner',
  use: 'on | <1-10> | off | status',
  filename: __filename,
}, async (message, text, extra) => {
  autoview.attach(extra?.Void || message?.bot || global.__saffulLatestSocket)
  if (!await isOwner(message, extra)) return message.reply('Owner only.')

  const input = String(text || '').trim().toLowerCase()
  if (!input || input === 'status') {
    const mode = autoview.getMode()
    const state = mode === 'off'
      ? 'OFF'
      : mode === 'instant'
        ? 'ON'
        : `${mode}-minute delay`
    return message.reply('Auto-view: ' + state + '.')
  }

  if (!autoview.normalizeMode(input)) return message.reply(input === '0' ? '0 is no longer supported. Use on, off or 1–10.' : 'Use .autoview on, off or 1–10.')
  try {
    const mode = autoview.setMode(input)
    if (mode === 'off') return message.reply('Auto-view: OFF.')
    if (mode === 'instant') return message.reply('Auto-view: ON.')
    return message.reply(`Auto-view: ${mode}-minute delay.`)
  } catch (error) {
    return message.reply('Could not save settings. Try again.')
  }
})

module.exports = { isOwner }
