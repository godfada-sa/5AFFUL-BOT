const { cmd } = require('../lib/plugins');

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '');
  return Boolean(owner && [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participantAlt,
    context?.mek?.key?.participant,
    context?.mek?.key?.participantAlt,
  ].some((jid) => String(jid || '').replace(/\D/g, '') === owner));
}

function normJid(jid) {
  return String(jid || '')
    .replace(/:\d+@/g, '@')
    .replace(/@c\.us$/g, '@s.whatsapp.net');
}

function sameIdentity(aJids, bJids) {
  const a = new Set();
  for (const j of aJids || []) {
    const n = normJid(j);
    if (n && n.includes('@')) a.add(n);
  }
  if (!a.size) return false;
  for (const j of bJids || []) {
    const n = normJid(j);
    if (n && n.includes('@') && a.has(n)) return true;
  }
  return false;
}

function botIdentities(message) {
  const user = message?.bot?.user || message?.bot?.authState?.creds?.me || {};
  return [
    user.id,
    user.lid,
    user.phoneNumber,
    message?.user,
    message?.botNumber,
    message?.bot?.decodeJid ? message.bot.decodeJid(user.id) : null,
  ].filter(Boolean);
}

function participantIdentities(p) {
  return [p?.id, p?.lid, p?.phoneNumber].filter(Boolean);
}

function isBotAdminIn(participants, message) {
  const botIds = botIdentities(message);
  return participants.some((p) => p?.admin && sameIdentity(botIds, participantIdentities(p)));
}

function mentionJids(message, context) {
  return message?.mention
    || message?.mentionedJid
    || message?.data?.message?.extendedTextMessage?.contextInfo?.mentionedJid
    || context?.mek?.message?.extendedTextMessage?.contextInfo?.mentionedJid
    || [];
}

// Remove any existing broken kick command from group.smd
const { commands } = require('../lib/plugins');
setImmediate(() => {
  const idx = commands.findIndex((c) => {
    const names = [c.pattern, ...(Array.isArray(c.alias) ? c.alias : []),
                   ...(Array.isArray(c.cmdname) ? c.cmdname : [])]
      .map((n) => String(n || '').toLowerCase().trim());
    return names.includes('kick') && String(c.filename || '').includes('group.smd');
  });
  if (idx !== -1) {
    commands.splice(idx, 1);
    console.log('[kick.js] Removed broken kick command from group.smd');
  }
});

cmd({
  pattern: 'kick',
  alias: ['remove'],
  desc: 'Kick a member from the group',
  category: 'group',
  use: '<@mention|reply|number>',
}, async (message, text, context) => {
  if (!message.isGroup) return message.reply('This command can only be used in a group.');

  // Permission gate: owner/sudo always allowed; otherwise the SENDER must be a group admin.
  let participants = message?.metadata?.participants;
  if (!participants?.length) {
    try {
      const group = await message.bot.groupMetadata(message.chat);
      participants = group?.participants || [];
    } catch {}
  }

  const senderIsAdmin = isOwner(message, context)
    || participants.some((p) => p?.admin && sameIdentity([message.sender, message.key?.participant], participantIdentities(p)));
  if (!senderIsAdmin) return message.reply('Only group admins or the bot owner can use this command.');

  // Resolve the target: reply → mention → typed number/JID.
  let target = message.quoted?.key?.participant;
  if (!target) {
    const mentions = mentionJids(message, context);
    target = mentions[0];
  }
  if (!target && text) {
    const cleaned = String(text).trim();
    target = /^\d+$/.test(cleaned) ? `${cleaned}@s.whatsapp.net` : cleaned;
  }
  if (!target) return message.reply('Reply to a message, mention someone, or give a number.\nExample: *.kick* on a reply');

  // Bot must be admin
  const botIsAdmin = (participants?.length ? isBotAdminIn(participants, message) : false)
    || message.isBotAdmin === true;
  if (!botIsAdmin) return message.reply('I am not an administrator in this group.');

  const targetIds = [target];

  // Check target is in the group
  if (participants?.length && !participants.some((p) => sameIdentity(targetIds, participantIdentities(p)))) {
    return message.reply('That member is not in this group.');
  }

  // Never kick an admin
  if (participants.some((p) => p?.admin && sameIdentity(targetIds, participantIdentities(p)))) {
    return message.reply(`Cannot kick @${target.split('@')[0]} — they are an administrator.`);
  }

  // Don't kick the bot itself
  if (sameIdentity(targetIds, botIdentities(message))) return message.reply("I can't kick myself.");

  try {
    const socket = message.bot;
    if (!socket?.groupParticipantsUpdate) throw new Error('No WhatsApp socket available');
    await socket.groupParticipantsUpdate(message.chat, [target], 'remove');
    await message.reply(`@${target.split('@')[0]} has been kicked from the group.`, { mentions: [target] });
  } catch (error) {
    console.error('[kick] failed:', error.message || error);
    await message.reply('Something went wrong while kicking that member.');
  }
});
