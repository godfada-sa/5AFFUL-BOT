const { cmd, commands } = require('../lib');
const { sleep } = require('sleep-promise');

// Remove the broken .kick command from group.smd so it doesn't intercept
setImmediate(() => {
  const brokenKickIdx = commands.findIndex(c => {
    const names = [c.pattern, ...(Array.isArray(c.alias) ? c.alias : []), ...(Array.isArray(c.cmdname) ? c.cmdname : [])].map(n => String(n || '').toLowerCase().trim());
    return names.includes('kick') && String(c.filename || '').includes('group.smd');
  });
  if (brokenKickIdx !== -1) {
    commands.splice(brokenKickIdx, 1);
    console.log('[kick.js] Removed broken .kick command from group.smd');
  }
});

// Same admin check pattern as tkick.js (the fixed version)
function isOwnerOrAdmin(msg, ctx) {
  // Check if user is sudo or creator
  if (ctx?.isSudo || msg?.isCreator) return true;

  // Check against OWNER_NUMBER
  const ownerNumber = String(process.env.OWNER_NUMBER || global.OWNER || '').replace(/\D/g, '');
  if (!ownerNumber) return false;

  return [
    msg?.sender,
    msg?.participant,
    msg?.quoted?.sender,
    ctx?.quoted?.participant,
    ctx?.quoted?.participant
  ].some(jid => String(jid || '').replace(/\D/g, '') === ownerNumber);
}

// Normalize JID for comparison (strip device suffix, fix @c.us -> @s.whatsapp.net)
function normalizeJid(jid) {
  return String(jid || '').replace(/:\d+@/g, '@').replace(/@c\.us$/g, '@s.whatsapp.net');
}

// Check if two JID sets overlap
function jidOverlap(set1, set2) {
  const s1 = new Set();
  for (const j of set1 || []) {
    const n = normalizeJid(j);
    if (n && n.includes('@')) s1.add(n);
  }
  if (!s1.size) return false;
  for (const j of set2 || []) {
    const n = normalizeJid(j);
    if (n && n.includes('@') && s1.has(n)) return true;
  }
  return false;
}

// Get bot's JIDs from the message context
function getBotJids(msg) {
  const me = msg?.user || msg?.bot?.user?.me || {};
  return [me.id, me.jid, me.remoteJid, msg?.user, msg?.creator,
    msg?.bot?.user?.id ? msg?.user?.id(me.id) : null
  ].filter(Boolean);
}

// Get participant JIDs
function getParticipantJids(participant) {
  return [participant?.id, participant?.jid, participant?.remoteJid].filter(Boolean);
}

// Check if sender is a group admin
function isSenderAdmin(participants, msg) {
  const botJids = getBotJids(msg);
  return participants.some(p =>
    p?.admin && jidOverlap(botJids, getParticipantJids(p))
  );
}

// Extract mentioned/replied JIDs from message
function getTargetJids(msg, ctx) {
  return msg?.mentionedJid || msg?.mentionedJids ||
    msg?.quoted?.message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    ctx?.quoted?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

cmd({
  pattern: 'kick',
  alias: ['remove'],
  desc: 'Kick a mentioned/replied user from the group',
  type: 'group',
  filename: __filename,
  use: '<@mention or reply>'
}, async (msg, args, ctx) => {
  try {
    if (!msg.isGroup) return msg.reply('This command can only be used in groups.');

    // Get group participants
    let participants = msg?.metadata?.participants;
    if (!participants?.length) {
      try {
        const meta = await msg.bot.groupMetadata(msg.chat);
        participants = meta?.participants || [];
      } catch {}
    }

    // Check if sender is admin/owner
    const hasPermission = isOwnerOrAdmin(msg, ctx) ||
      participants.some(p => {
        const senderJids = [msg.sender, msg.contextInfo?.participant];
        return p?.admin && jidOverlap(senderJids, getParticipantJids(p));
      });

    if (!hasPermission) {
      return msg.reply('Only admins or the bot owner can use this command.');
    }

    // Get target user to kick
    let target = msg?.quoted?.message?.extendedTextMessage?.contextInfo?.participant;
    if (!target) {
      const mentioned = getTargetJids(msg, ctx);
      target = mentioned[0];
    }
    if (!target && args) {
      const trimmed = String(args).trim();
      target = /^\d+$/.test(trimmed) ? trimmed + '@s.whatsapp.net' : trimmed;
    }

    if (!target) {
      return msg.reply('Reply to a message or mention a user to kick them.');
    }

    // Check if target is a group member
    const targetNormalized = normalizeJid(target);
    const isMember = participants?.some(p =>
      jidOverlap([targetNormalized], getParticipantJids(p))
    );

    if (!isMember) {
      return msg.reply('That member is not in this group.');
    }

    // Check if target is an admin (can't kick admins)
    const targetIsAdmin = participants?.some(p =>
      p?.admin && jidOverlap([targetNormalized], getParticipantJids(p))
    );

    if (targetIsAdmin) {
      return msg.reply('I can\'t kick an admin from the group.');
    }

    // Check if trying to kick self
    const botJids = getBotJids(msg);
    if (jidOverlap([targetNormalized], botJids)) {
      return msg.reply('I can\'t kick myself.');
    }

    // Kick the user
    await msg.bot.groupParticipantsUpdate(msg.chat, [target], 'remove');
    await msg.reply(`@${target.split('@')[0]} has been kicked from the group.`, {
      mentions: [target]
    });
  } catch (err) {
    console.error('Kick command error:', err.message || err);
    await msg.reply('Something went wrong while trying to kick the member.');
  }
});
