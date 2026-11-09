'use strict'

const { normalizedJid, resolvePhone, senderIds } = require('./safful-identities')

function participantIds(participant) {
  return [
    participant?.id,
    participant?.lid,
    participant?.phoneNumber,
    participant?.pn,
    participant?.jid,
  ].filter(Boolean)
}

function botIds(message, socket) {
  const me = socket?.authState?.creds?.me || socket?.user || {}
  return [
    socket?.user?.id,
    socket?.user?.lid,
    me.id,
    me.lid,
    message?.botNumber,
    message?.bot?.user?.id,
  ].filter(Boolean)
}

function findSocket(message, meta = {}, explicit) {
  const candidates = [
    explicit,
    message?.bot,
    message?.client,
    message?.sock,
    message?.conn,
    meta?.bot,
    meta?.client,
    meta?.sock,
    meta?.conn,
    meta?.Void,
    global.__saffulLatestSocket,
  ]
  return candidates.find((candidate) =>
    candidate && typeof candidate.groupMetadata === 'function'
  ) || explicit || message?.bot || global.__saffulLatestSocket
}

async function aliases(socket, values) {
  const result = new Set()
  for (const value of values || []) {
    const normalized = normalizedJid(value)
    if (normalized) result.add(normalized)
  }
  const phone = await resolvePhone(socket, ...(values || []))
  if (phone) result.add(phone)
  return result
}

async function sameIdentity(socket, left, right) {
  const [leftAliases, rightAliases] = await Promise.all([
    aliases(socket, left),
    aliases(socket, right),
  ])
  for (const id of leftAliases) if (rightAliases.has(id)) return true
  return false
}

async function freshParticipants(message, socket) {
  const chat = message?.chat || message?.jid || message?.key?.remoteJid
  if (chat && typeof socket?.groupMetadata === 'function') {
    try {
      const metadata = await socket.groupMetadata(chat)
      if (Array.isArray(metadata?.participants)) return metadata.participants
    } catch {}
  }
  return message?.metadata?.participants || message?.groupMetadata?.participants || []
}

function syncAdminFlags(message, meta, isAdmin, isBotAdmin) {
  // The bundled group commands are not consistent: some read flags from the
  // serialized message while others destructure them from the third handler
  // argument. Keep both views identical after the live metadata lookup.
  message.isAdmin = isAdmin
  message.isAdmins = isAdmin
  message.isBotAdmin = isBotAdmin
  message.botAdmin = isBotAdmin
  if (meta && typeof meta === 'object') {
    meta.isAdmin = isAdmin
    meta.isAdmins = isAdmin
    meta.isBotAdmin = isBotAdmin
    meta.botAdmin = isBotAdmin
  }
}

async function refreshAdminFlags(message, meta = {}, socket = message?.bot) {
  socket = findSocket(message, meta, socket)
  if (!message?.isGroup) return { isAdmin: Boolean(message?.isAdmin), isBotAdmin: Boolean(message?.isBotAdmin) }
  const participants = await freshParticipants(message, socket)
  if (!participants.length) return { isAdmin: Boolean(message?.isAdmin), isBotAdmin: Boolean(message?.isBotAdmin) }

  const admins = participants.filter((participant) => Boolean(participant?.admin))
  const sender = senderIds(message)
  const bot = botIds(message, socket)
  let isAdmin = Boolean(message.isCreator || meta?.isCreator)
  let isBotAdmin = false

  if (!isAdmin) {
    for (const participant of admins) {
      if (await sameIdentity(socket, sender, participantIds(participant))) {
        isAdmin = true
        break
      }
    }
  }

  for (const participant of admins) {
    if (await sameIdentity(socket, bot, participantIds(participant))) {
      isBotAdmin = true
      break
    }
  }

  syncAdminFlags(message, meta, isAdmin, isBotAdmin)
  return { isAdmin, isBotAdmin }
}

module.exports = {
  aliases,
  botIds,
  findSocket,
  participantIds,
  refreshAdminFlags,
  sameIdentity,
  syncAdminFlags,
}
