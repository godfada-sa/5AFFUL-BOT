'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { refreshAdminFlags } = require('../lib/safful-admin-resolver')

function socket(participants) {
  return {
    user: { id: '233500000002:9@s.whatsapp.net' },
    groupMetadata: async () => ({ participants }),
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => ({
          '111111111111111@lid': '233500000001@s.whatsapp.net',
          '222222222222222@lid': '233500000002@s.whatsapp.net',
        })[lid] || '',
      },
    },
  }
}

test('admin recognition bridges participantAlt phone JID to roster LID', async () => {
  const bot = socket([
    { id: '111111111111111@lid', admin: 'admin' },
    { id: '222222222222222@lid', admin: 'admin' },
  ])
  const message = {
    isGroup: true,
    chat: '123@g.us',
    bot,
    key: {
      participant: '111111111111111@lid',
      participantAlt: '233500000001@s.whatsapp.net',
    },
  }

  const result = await refreshAdminFlags(message, {}, bot)
  assert.equal(result.isAdmin, true)
  assert.equal(result.isBotAdmin, true)
})

test('non-admin member is not promoted and fresh metadata wins', async () => {
  const bot = socket([
    { id: '111111111111111@lid', admin: null },
    { id: '222222222222222@lid', admin: 'admin' },
  ])
  const message = {
    isGroup: true,
    chat: '123@g.us',
    bot,
    metadata: { participants: [{ id: '111111111111111@lid', admin: 'admin' }] },
    key: { participant: '111111111111111@lid' },
  }

  const result = await refreshAdminFlags(message, {}, bot)
  assert.equal(result.isAdmin, false)
  assert.equal(result.isBotAdmin, true)
})

test('group command wrapper refreshes flags before its original handler', async () => {
  const registry = [{
    filename: 'plugins/group.smd',
    function: async (message) => message.isAdmin,
  }]
  const bot = socket([{ id: '111111111111111@lid', admin: 'admin' }])
  const message = {
    isGroup: true,
    chat: '123@g.us',
    bot,
    key: { participantAlt: '233500000001@s.whatsapp.net' },
  }

  const { patchAdminCommands } = require('../lib/safful-admin-command-patch')
  assert.equal(patchAdminCommands(registry), 1)
  assert.equal(await registry[0].function(message, '', {}), true)
})

test('live command metadata supplies the socket when message.bot is absent', async () => {
  const observed = {}
  const registry = [{
    filename: 'plugins/group.smd',
    pattern: 'add',
    function: async (message, _text, meta) => {
      Object.assign(observed, {
        messageAdmin: message.isAdmin,
        contextAdmin: meta.isAdmin,
        messageBotAdmin: message.isBotAdmin,
        contextBotAdmin: meta.isBotAdmin,
      })
      return message.isAdmin && meta.isAdmin
    },
  }]
  const liveSocket = socket([
    { id: '111111111111111@lid', admin: 'admin' },
    { id: '222222222222222@lid', admin: 'admin' },
  ])
  const message = {
    isGroup: true,
    chat: '123@g.us',
    key: { participantAlt: '233500000001@s.whatsapp.net' },
  }

  const { patchAdminCommands } = require('../lib/safful-admin-command-patch')
  assert.equal(patchAdminCommands(registry), 1)
  const context = { Void: liveSocket, isAdmin: false, isBotAdmin: false }
  assert.equal(await registry[0].function(message, '', context), true)
  assert.deepEqual(observed, {
    messageAdmin: true,
    contextAdmin: true,
    messageBotAdmin: true,
    contextBotAdmin: true,
  })
})

test('fresh metadata clears stale admin flags for non-admin members', async () => {
  const liveSocket = socket([
    { id: '111111111111111@lid', admin: null },
    { id: '222222222222222@lid', admin: 'admin' },
  ])
  const message = {
    isGroup: true,
    isAdmin: true,
    isBotAdmin: true,
    chat: '123@g.us',
    key: { participantAlt: '233500000001@s.whatsapp.net' },
  }
  const context = { Void: liveSocket, isAdmin: true, isBotAdmin: true }

  const result = await refreshAdminFlags(message, context)
  assert.equal(result.isAdmin, false)
  assert.equal(result.isBotAdmin, true)
  assert.equal(message.isAdmin, false)
  assert.equal(context.isAdmin, false)
})
