const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('sharp')
const { cmd, commands } = require('../lib/plugins')

const GROUP_COMMANDS = new Set([
  'join', 'newgc', 'ginfo', 'rejectall', 'rejectjoin', 'acceptall', 'acceptjoin',
  'listrequest', 'requestjoin', 'setdesc', 'setgdesc', 'gdesc', 'setname',
  'setgname', 'gname', 'left', 'gpp', 'fullgpp', 'common', 'diff', 'invite',
  'revoke', 'tagall', 'kik', 'fkik', 'num', 'poll', 'promote', 'kick', 'group',
  'pick', 'ship', 'mute', 'unmute', 'lock', 'unlock', 'tag', 'hidetag',
  'tagadmin', 'add', 'getjids', 'gjid', 'gjids', 'allgc', 'gclist', 'demote', 'all',
  'del', 'delete', 'dlt', 'broadcast',
])

function commandNames(command) {
  return [command?.pattern, command?.cmdname]
    .concat(Array.isArray(command?.alias) ? command.alias : [])
    .filter(Boolean)
    .map(value => String(value).toLowerCase().trim())
}

function removeGroupCommands() {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (commandNames(commands[index]).some(name => GROUP_COMMANDS.has(name))) commands.splice(index, 1)
  }
}

function register(config, handler) {
  cmd({ category: 'group', filename: __filename, ...config }, handler)
}

function normalizeJid(value) {
  return String(value || '').replace(/:\d+@/g, '@').replace(/@c\.us$/i, '@s.whatsapp.net')
}

function identities(values) {
  const result = new Set()
  for (const raw of values.flat(Infinity)) {
    const jid = normalizeJid(raw)
    if (!jid) continue
    result.add(jid)
    const digits = jid.split('@')[0].replace(/\D/g, '')
    if (digits) result.add(digits)
  }
  return result
}

function participantIds(participant) {
  return identities([participant?.id, participant?.lid, participant?.phoneNumber])
}

function overlaps(left, right) {
  const a = left instanceof Set ? left : identities(left)
  const b = right instanceof Set ? right : identities(right)
  for (const value of a) if (b.has(value)) return true
  return false
}

function socketFor(message) {
  return message?.bot || message?.client || global.__saffulLatestSocket
}

function ownerIds() {
  return identities(String(process.env.SUDO || process.env.OWNER_NUMBER || global.sudo || global.owner || '').match(/\d{7,}/g) || [])
}

function senderIds(message, extra = {}) {
  return identities([
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    extra?.mek?.key?.participant,
    extra?.mek?.key?.participantAlt,
  ])
}

function isOwner(message, extra = {}) {
  return Boolean(message?.fromMe || extra?.isCreator || overlaps(senderIds(message, extra), ownerIds()))
}

async function metadataFor(message) {
  if (message?.metadata?.participants?.length) return message.metadata
  const socket = socketFor(message)
  if (!message?.chat || typeof socket?.groupMetadata !== 'function') throw new Error('Group metadata is unavailable.')
  return socket.groupMetadata(message.chat)
}

function botIds(message) {
  const socket = socketFor(message)
  return identities([socket?.user?.id, socket?.user?.lid, socket?.user?.phoneNumber])
}

async function groupContext(message, extra = {}, requirements = {}) {
  const { admin = false, botAdmin = false } = requirements
  if (!message?.isGroup && !String(message?.chat || '').endsWith('@g.us')) {
    await message.reply('This command only works in a group.')
    return null
  }
  let metadata
  try { metadata = await metadataFor(message) } catch (error) {
    await message.reply(error?.message || 'Could not read this group.')
    return null
  }
  const sender = senderIds(message, extra)
  const senderAdmin = metadata.participants?.some(participant => participant?.admin && overlaps(sender, participantIds(participant)))
  const botIsAdmin = metadata.participants?.some(participant => participant?.admin && overlaps(botIds(message), participantIds(participant)))
  const owner = isOwner(message, extra)
  message.isAdmin = Boolean(senderAdmin || owner)
  message.isBotAdmin = Boolean(botIsAdmin)

  if (admin && !senderAdmin && !owner) {
    await message.reply('Only a group admin or the bot owner can use this command.')
    return null
  }
  if (botAdmin && !botIsAdmin) {
    await message.reply('Make me a group admin first.')
    return null
  }
  return { metadata, owner, senderAdmin, botIsAdmin, socket: socketFor(message) }
}

async function ownerOnly(message, extra) {
  if (isOwner(message, extra)) return true
  await message.reply('This command is owner-only.')
  return false
}

function mentionedJids(message, extra = {}) {
  const context = extra?.mek?.message?.extendedTextMessage?.contextInfo ||
    extra?.mek?.message?.imageMessage?.contextInfo ||
    message?.message?.extendedTextMessage?.contextInfo || {}
  return []
    .concat(message?.mentionedJid || message?.mentions || context?.mentionedJid || [])
    .filter(Boolean)
}

function targetFrom(message, text, metadata, extra = {}) {
  const quoted = message?.quoted || message?.reply_message || message?.replyMessage
  const candidates = [quoted?.sender, quoted?.key?.participant, quoted?.key?.participantAlt]
    .concat(mentionedJids(message, extra))
    .filter(Boolean)
  const digits = String(text || '').match(/\d{7,}/)?.[0]
  if (digits) candidates.push(`${digits}@s.whatsapp.net`, digits)

  for (const candidate of candidates) {
    const match = metadata?.participants?.find(participant => overlaps([candidate], participantIds(participant)))
    if (match) return match.id || match.lid || match.phoneNumber
  }
  return candidates[0] ? normalizeJid(candidates[0]) : null
}

async function send(message, content, options = {}) {
  const socket = socketFor(message)
  if (typeof socket?.sendMessage !== 'function') throw new Error('WhatsApp socket is unavailable.')
  return socket.sendMessage(message.chat, content, { quoted: message, ...options })
}

async function mediaBuffer(message) {
  const candidates = [message?.quoted, message?.reply_message, message?.replyMessage, message]
  for (const candidate of candidates) {
    if (!candidate) continue
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
  throw new Error('Reply to an image first.')
}

function memberJid(participant) {
  return participant?.id || participant?.lid || participant?.phoneNumber
}

function mentionText(jid) {
  return `@${String(jid || '').split('@')[0]}`
}

removeGroupCommands()

register({ pattern: 'join', desc: 'Join a group from an invite link', category: 'owner', fromMe: true }, async (message, text, extra) => {
  if (!(await ownerOnly(message, extra))) return
  const code = String(text || '').match(/chat\.whatsapp\.com\/([\w-]+)/i)?.[1] || String(text || '').trim()
  if (!code) return message.reply('Usage: `.join <WhatsApp group invite link>`')
  try {
    const jid = await socketFor(message).groupAcceptInvite(code)
    return message.reply(`Joined group: ${jid}`)
  } catch (error) {
    return message.reply(`Could not join: ${error?.message || error}`)
  }
})

register({ pattern: 'newgc', desc: 'Create a new group', category: 'owner', fromMe: true, use: '<name|number,number>' }, async (message, text, extra) => {
  if (!(await ownerOnly(message, extra))) return
  const [subject, rawNumbers = ''] = String(text || '').split('|')
  if (!subject?.trim()) return message.reply('Usage: `.newgc Group name|233xxxxxxxxx,234xxxxxxxxx`')
  const participants = (rawNumbers.match(/\d{7,}/g) || []).map(number => `${number}@s.whatsapp.net`)
  try {
    const result = await socketFor(message).groupCreate(subject.trim(), participants)
    return message.reply(`Group created: ${result?.id || subject.trim()}`)
  } catch (error) {
    return message.reply(`Could not create group: ${error?.message || error}`)
  }
})

register({ pattern: 'ginfo', desc: 'Show group information' }, async message => {
  const context = await groupContext(message)
  if (!context) return
  const metadata = context.metadata
  const admins = metadata.participants?.filter(participant => participant?.admin).length || 0
  return message.reply([
    `👥 *${metadata.subject || 'Group'}*`,
    `🆔 ${metadata.id || message.chat}`,
    `👤 Members: ${metadata.participants?.length || 0}`,
    `🛡️ Admins: ${admins}`,
    metadata.desc ? `📝 ${metadata.desc}` : '',
  ].filter(Boolean).join('\n'))
})

async function joinRequests(message, extra, action) {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  if (typeof context.socket.groupRequestParticipantsList !== 'function') return message.reply('Join requests are not supported by this WhatsApp session.')
  const requests = await context.socket.groupRequestParticipantsList(message.chat)
  const jids = (requests || []).map(request => request?.jid || request?.id).filter(Boolean)
  if (action === 'list') {
    if (!jids.length) return message.reply('There are no pending join requests.')
    return send(message, { text: `📥 *Pending requests (${jids.length})*\n${jids.map(mentionText).join('\n')}`, mentions: jids })
  }
  if (!jids.length) return message.reply('There are no pending join requests.')
  if (typeof context.socket.groupRequestParticipantsUpdate !== 'function') return message.reply('Approving/rejecting requests is not supported by this session.')
  await context.socket.groupRequestParticipantsUpdate(message.chat, jids, action)
  return message.reply(`${action === 'approve' ? 'Approved' : 'Rejected'} ${jids.length} join request(s).`)
}

register({ pattern: 'listrequest', alias: ['requestjoin'], desc: 'List pending group join requests' }, (message, text, extra) => joinRequests(message, extra, 'list'))
register({ pattern: 'acceptall', alias: ['acceptjoin'], desc: 'Approve all pending join requests' }, (message, text, extra) => joinRequests(message, extra, 'approve'))
register({ pattern: 'rejectall', alias: ['rejectjoin'], desc: 'Reject all pending join requests' }, (message, text, extra) => joinRequests(message, extra, 'reject'))

register({ pattern: 'setdesc', alias: ['setgdesc', 'gdesc'], desc: 'Change the group description', use: '<description>' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  if (!String(text || '').trim()) return message.reply('Usage: `.setdesc <description>`')
  await context.socket.groupUpdateDescription(message.chat, String(text).trim())
  return message.reply('Group description updated.')
})

register({ pattern: 'setname', alias: ['setgname', 'gname'], desc: 'Change the group subject', use: '<name>' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  const name = String(text || '').trim()
  if (!name) return message.reply('Usage: `.setname <group name>`')
  await context.socket.groupUpdateSubject(message.chat, name.slice(0, 100))
  return message.reply('Group name updated.')
})

register({ pattern: 'left', alias: ['leavegc'], desc: 'Leave the current group', category: 'owner', fromMe: true }, async (message, text, extra) => {
  if (!(await ownerOnly(message, extra))) return
  const context = await groupContext(message)
  if (!context) return
  await message.reply('Leaving this group. 👋')
  return context.socket.groupLeave(message.chat)
})

register({ pattern: 'gpp', desc: 'Set the group profile picture' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  let file
  try {
    const image = await sharp(await mediaBuffer(message)).jpeg({ quality: 90 }).toBuffer()
    file = path.join(os.tmpdir(), `safful-gpp-${Date.now()}.jpg`)
    fs.writeFileSync(file, image)
    await context.socket.updateProfilePicture(message.chat, { url: file })
    return message.reply('Group profile picture updated.')
  } catch (error) {
    return message.reply(`Could not update the group picture: ${error?.message || error}`)
  } finally {
    try { if (file && fs.existsSync(file)) fs.unlinkSync(file) } catch {}
  }
})

register({ pattern: 'fullgpp', desc: 'Show the full group profile picture' }, async message => {
  const context = await groupContext(message)
  if (!context) return
  try {
    const url = await context.socket.profilePictureUrl(message.chat, 'image')
    return send(message, { image: { url }, caption: `🖼️ ${context.metadata.subject || 'Group picture'}` })
  } catch {
    return message.reply('This group has no accessible profile picture.')
  }
})

async function compareGroups(message, text, mode) {
  const current = await groupContext(message)
  if (!current) return
  const otherJid = String(text || '').match(/[\d-]+@g\.us/)?.[0]
  if (!otherJid) return message.reply(`Usage: \`.${mode} <other-group-jid>\``)
  let other
  try { other = await current.socket.groupMetadata(otherJid) } catch { return message.reply('I cannot read that other group.') }
  const otherIds = other.participants.map(participantIds)
  const selected = current.metadata.participants.filter(participant => {
    const exists = otherIds.some(ids => overlaps(participantIds(participant), ids))
    return mode === 'common' ? exists : !exists
  })
  const jids = selected.map(memberJid).filter(Boolean)
  return send(message, { text: `${mode === 'common' ? '🤝 Common' : '➖ Different'} members: *${jids.length}*\n${jids.map(mentionText).join('\n')}`, mentions: jids })
}

register({ pattern: 'common', desc: 'List members shared with another group', category: 'owner', fromMe: true }, (message, text) => compareGroups(message, text, 'common'))
register({ pattern: 'diff', desc: 'List members not present in another group', category: 'owner', fromMe: true }, (message, text) => compareGroups(message, text, 'diff'))

register({ pattern: 'invite', desc: 'Get this group invite link' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  const code = await context.socket.groupInviteCode(message.chat)
  return message.reply(`https://chat.whatsapp.com/${code}`)
})

register({ pattern: 'revoke', desc: 'Reset this group invite link' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  const code = await context.socket.groupRevokeInvite(message.chat)
  return message.reply(`Invite link reset.\nhttps://chat.whatsapp.com/${code}`)
})

async function tagMembers(message, extra, mode) {
  const context = await groupContext(message, extra, { admin: true })
  if (!context) return
  let participants = context.metadata.participants || []
  if (mode === 'admins') participants = participants.filter(participant => participant?.admin)
  const jids = participants.map(memberJid).filter(Boolean)
  const body = String(extra?.text || '').trim()
  // A zero-width character carries the WhatsApp mention metadata without a
  // visible “Group announcement” or another text body in the chat.
  const text = mode === 'hidden'
    ? (body || '\u200B')
    : `${body ? `${body}\n\n` : ''}${jids.map(mentionText).join(' ')}`
  return send(message, { text, mentions: jids })
}

register({ pattern: 'tagall', desc: 'Mention every group member' }, (message, text, extra) => tagMembers(message, { ...extra, text }, 'all'))
register({ pattern: 'tag', alias: ['hidetag', 'all'], desc: 'Silently mention every group member' }, (message, text, extra) => tagMembers(message, { ...extra, text }, 'hidden'))
register({ pattern: 'tagadmin', desc: 'Mention all group admins' }, (message, text, extra) => tagMembers(message, { ...extra, text }, 'admins'))

async function participantAction(message, text, extra, action, pastTense) {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  const target = targetFrom(message, text, context.metadata, extra)
  if (!target) return message.reply('Reply to, mention, or provide the number of a group member.')
  if (overlaps([target], botIds(message))) return message.reply('I cannot apply that action to myself.')
  try {
    const response = await context.socket.groupParticipantsUpdate(message.chat, [target], action)
    const failure = response?.[0]?.status && Number(response[0].status) >= 400
    if (failure) throw new Error(`WhatsApp returned status ${response[0].status}`)
    return send(message, { text: `${mentionText(target)} ${pastTense}.`, mentions: [target] })
  } catch (error) {
    return message.reply(`Action failed: ${error?.message || error}`)
  }
}

register({ pattern: 'kick', alias: ['kik', 'fkik'], desc: 'Remove a member from the group' }, (message, text, extra) => participantAction(message, text, extra, 'remove', 'was removed'))
register({ pattern: 'promote', desc: 'Promote a member to admin' }, (message, text, extra) => participantAction(message, text, extra, 'promote', 'is now an admin'))
register({ pattern: 'demote', desc: 'Demote a group admin' }, (message, text, extra) => participantAction(message, text, extra, 'demote', 'is no longer an admin'))
register({ pattern: 'add', desc: 'Add a number to the group' }, (message, text, extra) => participantAction(message, text, extra, 'add', 'was added'))

register({ pattern: 'num', alias: ['membercount'], desc: 'Show the member count' }, async message => {
  const context = await groupContext(message)
  return context && message.reply(`👥 *${context.metadata.participants?.length || 0}* members`)
})

register({ pattern: 'poll', desc: 'Create a WhatsApp poll', use: '<question|option 1|option 2>' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true })
  if (!context) return
  const [name, ...values] = String(text || '').split('|').map(value => value.trim()).filter(Boolean)
  if (!name || values.length < 2) return message.reply('Usage: `.poll Question|Option 1|Option 2`')
  return send(message, { poll: { name, values: values.slice(0, 12), selectableCount: 1 } })
})

async function setGroupMode(message, extra, setting, label) {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  await context.socket.groupSettingUpdate(message.chat, setting)
  return message.reply(label)
}

register({ pattern: 'group', desc: 'Open or close group messaging', use: '<open|close>' }, async (message, text, extra) => {
  const action = String(text || '').trim().toLowerCase()
  if (!['open', 'close'].includes(action)) return message.reply('Usage: `.group open` or `.group close`')
  return setGroupMode(message, extra, action === 'close' ? 'announcement' : 'not_announcement', `Group is now ${action}.`)
})
register({ pattern: 'mute', desc: 'Allow only admins to send messages' }, (message, text, extra) => setGroupMode(message, extra, 'announcement', 'Group muted.'))
register({ pattern: 'unmute', desc: 'Allow all members to send messages' }, (message, text, extra) => setGroupMode(message, extra, 'not_announcement', 'Group unmuted.'))
register({ pattern: 'lock', desc: 'Allow only admins to edit group settings', category: 'owner', fromMe: true }, (message, text, extra) => setGroupMode(message, extra, 'locked', 'Group settings locked.'))
register({ pattern: 'unlock', desc: 'Allow members to edit group settings', category: 'owner', fromMe: true }, (message, text, extra) => setGroupMode(message, extra, 'unlocked', 'Group settings unlocked.'))

register({ pattern: 'pick', desc: 'Pick a random group member' }, async message => {
  const context = await groupContext(message)
  if (!context) return
  const candidates = context.metadata.participants.map(memberJid).filter(jid => jid && !overlaps([jid], botIds(message)))
  if (!candidates.length) return message.reply('No members available to pick.')
  const selected = candidates[Math.floor(Math.random() * candidates.length)]
  return send(message, { text: `🎯 I pick ${mentionText(selected)}!`, mentions: [selected] })
})

register({ pattern: 'ship', desc: 'Randomly ship two group members' }, async message => {
  const context = await groupContext(message)
  if (!context) return
  const candidates = context.metadata.participants.map(memberJid).filter(jid => jid && !overlaps([jid], botIds(message)))
  if (candidates.length < 2) return message.reply('At least two members are needed.')
  const firstIndex = Math.floor(Math.random() * candidates.length)
  const first = candidates.splice(firstIndex, 1)[0]
  const second = candidates[Math.floor(Math.random() * candidates.length)]
  const score = 50 + Math.floor(Math.random() * 51)
  return send(message, { text: `💞 ${mentionText(first)} × ${mentionText(second)} — *${score}%*`, mentions: [first, second] })
})

register({ pattern: 'getjids', alias: ['gjid', 'gjids', 'allgc', 'gclist'], desc: 'List joined group JIDs', category: 'owner', fromMe: true }, async (message, text, extra) => {
  if (!(await ownerOnly(message, extra))) return
  const socket = socketFor(message)
  if (typeof socket?.groupFetchAllParticipating !== 'function') return message.reply('Group listing is unavailable.')
  const groups = await socket.groupFetchAllParticipating()
  const values = Object.values(groups || {})
  return message.reply(values.length ? values.map(group => `• ${group.subject || 'Group'}\n  ${group.id}`).join('\n') : 'No groups found.')
})

register({ pattern: 'del', alias: ['delete', 'dlt'], desc: 'Delete a replied message' }, async (message, text, extra) => {
  const context = await groupContext(message, extra, { admin: true, botAdmin: true })
  if (!context) return
  const quoted = message?.quoted || message?.reply_message || message?.replyMessage
  const key = quoted?.key || extra?.mek?.message?.extendedTextMessage?.contextInfo
  if (!key) return message.reply('Reply to the message you want deleted.')
  const deleteKey = key.remoteJid ? key : {
    remoteJid: message.chat,
    id: key.stanzaId,
    participant: key.participant,
    fromMe: false,
  }
  await context.socket.sendMessage(message.chat, { delete: deleteKey })
})

function privateChatIds(socket) {
  const ids = new Set()
  for (const source of [socket?.contacts, socket?.chats]) {
    for (const jid of Object.keys(source || {})) {
      if (/@(s\.whatsapp\.net|lid)$/i.test(jid)) ids.add(normalizeJid(jid))
    }
  }
  // The local store records chats the current session has actually seen.
  // It is used as a fallback because Baileys does not always populate the
  // contacts map until a contact sends a fresh message after a restart.
  try {
    const store = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'store.json'), 'utf8'))
    for (const jid of Object.keys(store?.messages || store?.chats || {})) {
      if (/@(s\.whatsapp\.net|lid)$/i.test(jid)) ids.add(normalizeJid(jid))
    }
  } catch {}
  const own = normalizeJid(socket?.user?.id)
  ids.delete(own)
  return ids
}

async function broadcastTo(socket, targets, body) {
  let sent = 0
  let failed = 0
  for (const jid of targets) {
    try {
      await socket.sendMessage(jid, { text: body })
      sent += 1
    } catch {
      failed += 1
    }
    // A small pause avoids WhatsApp rate limits on larger chat lists.
    if (sent && sent % 12 === 0) await new Promise(resolve => setTimeout(resolve, 350))
  }
  return { sent, failed }
}

register({ pattern: 'broadcast', alias: ['gcast', 'bc'], desc: 'Broadcast to chats, groups, or all', category: 'owner', fromMe: true, use: '[chat|groups] <message>' }, async (message, text, extra) => {
  if (!(await ownerOnly(message, extra))) return
  const input = String(text || '').trim()
  if (!input) return message.reply('Usage: `.broadcast <message>` (all), `.broadcast chat <message>`, or `.broadcast groups <message>`.')
  const socket = socketFor(message)
  if (typeof socket?.sendMessage !== 'function') return message.reply('WhatsApp socket is unavailable.')
  const [requestedScope, ...words] = input.split(/\s+/)
  const scope = /^(chat|chats|contact|contacts)$/i.test(requestedScope)
    ? 'chat'
    : /^(group|groups)$/i.test(requestedScope)
      ? 'groups'
      : 'all'
  const body = scope === 'all' ? input : words.join(' ').trim()
  if (!body) return message.reply(`Usage: \`.broadcast ${scope === 'chat' ? 'chat' : 'groups'} <message>\`.`)

  const targets = new Set()
  if (scope !== 'chat') {
    try {
      const groups = await socket.groupFetchAllParticipating()
      for (const jid of Object.keys(groups || {})) targets.add(jid)
    } catch (error) {
      if (scope === 'groups') return message.reply(`Could not load groups: ${error?.message || error}`)
    }
  }
  if (scope !== 'groups') for (const jid of privateChatIds(socket)) targets.add(jid)
  if (!targets.size) return message.reply(`No ${scope === 'all' ? 'saved chats or groups' : scope === 'chat' ? 'saved chats' : 'groups'} were found.`)

  await message.reply(`📢 Sending to ${targets.size} ${scope === 'all' ? 'chats/groups' : scope}…`)
  const result = await broadcastTo(socket, targets, body)
  return message.reply(`✅ Broadcast complete. Sent: *${result.sent}*${result.failed ? ` • Failed: *${result.failed}*` : ''}`)
})


module.exports = {
  GROUP_COMMANDS,
  groupContext,
  identities,
  overlaps,
  targetFrom,
}
