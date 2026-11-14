'use strict'

const { cmd } = require('../lib/plugins')
const { isOperator } = require('../lib/safful-identities')
const statuses = require('../lib/safful-status-save')

for (const command of ['savestatus', 'savedelstat']) {
  cmd({ pattern: command, alias: command === 'savestatus' ? ['statussave'] : [],
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
      return message.reply('.' + command + ' is ' + (enabled ? 'ON' : 'OFF') + '. ' +
        (deleted ? 'Deleted statuses captured while enabled are sent to sudo with the contact name. Cache: up to 24 hours, 64 MB per account, 16 MB per item. Off clears this cache.' :
          'New received statuses are sent to sudo with the contact name. Limit: 16 MB per item. No media is kept on disk unless .savedelstat is on.'))
    } catch {
      return message.reply('Could not save the setting. Check the panel file permissions.')
    }
  })
}
