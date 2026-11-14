'use strict'

const { cmd } = require('../lib/plugins')
const { isOperator } = require('../lib/safful-identities')
const statuses = require('../lib/safful-status-save')

for (const command of ['savestatus', 'savedelstat']) {
  cmd({ pattern: command, alias: command === 'savestatus' ? ['statussave'] : ['savedelstatus'],
    desc: command === 'savestatus' ? 'Save new contact statuses to sudo' : 'Recover deleted contact statuses to sudo',
    category: 'owner', filename: __filename, use: 'on | off | status' }, async (message, text, meta = {}) => {
    const socket = meta.Void || message.bot
    if (!await isOperator(message, meta, socket)) return message.reply('Owner only.')
    statuses.attach(socket)
    const deleted = command === 'savedelstat'
    const input = String(text || '').trim().toLowerCase()
    if (input && !['on', 'off', 'status'].includes(input)) return message.reply('Use .' + command + ' on, off or status.')
    try {
      if (input === 'on' || input === 'off') statuses.setEnabled(input === 'on', deleted)
      const enabled = statuses.getEnabled(deleted)
      return message.reply('.' + command + ': ' + (enabled ? 'ON' : 'OFF') + '.' +
        (deleted && input === 'off' ? ' Cache cleared.' : ''))
    } catch {
      return message.reply('Could not save settings. Check file permissions.')
    }
  })
}
