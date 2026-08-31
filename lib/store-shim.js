'use strict'

// Small bounded replacement for Baileys' in-memory store. Keeping full raw
// messages indefinitely is the main avoidable source of memory growth.
const fs = require('fs')

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) ? Math.min(Math.max(number, minimum), maximum) : fallback
}

const MAX_MESSAGES_PER_CHAT = boundedNumber(process.env.SAFFUL_CACHE_MESSAGES, 25, 25, 500)
const MAX_CHATS = boundedNumber(process.env.SAFFUL_CACHE_CHATS, 30, 10, 500)
const WRITE_INTERVAL_MS = boundedNumber(process.env.SAFFUL_STORE_WRITE_SECONDS, 60, 15, 600) * 1000

module.exports = function makeInMemoryStore() {
  const chatLastUsed = new Map()
  let lastWrite = 0

  const store = {
    messages: {},
    contacts: {},
    bindFromEventEmitter(eventEmitter) {
      eventEmitter.on('messages.upsert', ({ messages = [] } = {}) => {
        for (const message of messages) {
          const chatId = message?.key?.remoteJid
          if (!chatId) continue
          if (!store.messages[chatId]) evictOldestChat()
          const bucket = store.messages[chatId] || (store.messages[chatId] = { array: [] })
          bucket.array.push(message)
          if (bucket.array.length > MAX_MESSAGES_PER_CHAT) bucket.array.splice(0, bucket.array.length - MAX_MESSAGES_PER_CHAT)
          chatLastUsed.set(chatId, Date.now())
        }
      })
      eventEmitter.on('contacts.upsert', (contacts = []) => {
        for (const contact of contacts) if (contact?.id) store.contacts[contact.id] = contact
      })
      eventEmitter.on('contacts.update', (updates = []) => {
        for (const update of updates) {
          if (update?.id && store.contacts[update.id]) Object.assign(store.contacts[update.id], update)
        }
      })
      return store
    },
    bind(eventEmitter) { return store.bindFromEventEmitter(eventEmitter) },
    async getMessages(chatId, id) {
      return store.messages[chatId]?.array?.find(message => message?.key?.id === id)
    },
    async loadMessage(chatId, id) { return store.getMessages(chatId, id) },
    loadFromFile(file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        const entries = Object.entries(saved?.messages || {})
          .map(([chatId, value]) => [chatId, Array.isArray(value) ? value : value?.array || []])
          .filter(([, messages]) => messages.length)
          .sort((a, b) => lastTimestamp(a[1]) - lastTimestamp(b[1]))
          .slice(-MAX_CHATS)
        store.messages = {}
        chatLastUsed.clear()
        for (const [chatId, messages] of entries) {
          store.messages[chatId] = { array: messages.filter(Boolean).slice(-MAX_MESSAGES_PER_CHAT) }
          chatLastUsed.set(chatId, lastTimestamp(messages))
        }
      } catch {}
      return store
    },
    readFromFile(file) { return store.loadFromFile(file) },
    writeToFile(file) {
      try {
        if (Date.now() - lastWrite < WRITE_INTERVAL_MS) return
        store.trim()
        fs.writeFileSync(file, JSON.stringify({ messages: store.messages }))
        lastWrite = Date.now()
      } catch {}
    },
    trim() {
      const ids = Object.keys(store.messages).sort((a, b) => (chatLastUsed.get(a) || 0) - (chatLastUsed.get(b) || 0))
      while (ids.length > MAX_CHATS) {
        const id = ids.shift()
        delete store.messages[id]
        chatLastUsed.delete(id)
      }
      for (const id of Object.keys(store.messages)) {
        const bucket = store.messages[id]
        if (Array.isArray(bucket?.array) && bucket.array.length > MAX_MESSAGES_PER_CHAT) {
          bucket.array = bucket.array.slice(-MAX_MESSAGES_PER_CHAT)
        }
      }
    },
  }

  function evictOldestChat() {
    const ids = Object.keys(store.messages)
    if (ids.length < MAX_CHATS) return
    const oldest = ids.sort((a, b) => (chatLastUsed.get(a) || 0) - (chatLastUsed.get(b) || 0))[0]
    if (oldest) {
      delete store.messages[oldest]
      chatLastUsed.delete(oldest)
    }
  }

  return store
}

function lastTimestamp(messages) {
  return Number(messages.at(-1)?.messageTimestamp) || 0
}
