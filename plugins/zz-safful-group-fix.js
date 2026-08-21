/**
 * safful-group-fix.js
 *
 * Patches ALL broken admin checks in group.smd by intercepting command
 * registrations. The core's isAdmin/isBotAdmin fields fail in LID-addressed
 * groups, causing commands like .mute, .unmute, .gpp, .setname, .setdesc, etc.
 * to always reply "you're not an admin" even when the user IS an admin.
 *
 * This module monkey-patches the smd/cmd functions so every command registered
 * from group.smd gets a pre-handler that re-checks admin status against the
 * participants metadata using LID/PN-aware identity matching (same as tkick.js).
 */

const { commands } = require('../lib');

// --- LID/PN-aware identity helpers (same as tkick.js) ---

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
    user.id, user.lid, user.phoneNumber,
    message?.user, message?.botNumber,
    message?.bot?.decodeJid ? message.bot.decodeJid(user.id) : null,
  ].filter(Boolean);
}

function participantIdentities(p) {
  return [p?.id, p?.lid, p?.phoneNumber].filter(Boolean);
}

function senderIdentities(message) {
  return [
    message?.sender,
    message?.senderNum,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.fakeObj?.key?.participantAlt,
  ].filter(Boolean);
}

function isOwner(message, context) {
  if (context?.isCreator || message?.fromMe) return true;
  const owner = String(process.env.OWNER_NUMBER || global.OWNER || '').replace(/\D/g, '');
  return Boolean(owner && senderIdentities(message).some(
    jid => String(jid || '').replace(/\D/g, '') === owner
  ));
}

async function recheckAdmin(message, context) {
  if (!message?.isGroup) return;

  let participants = message?.metadata?.participants;
  if (!participants?.length) {
    try {
      const group = await message.bot.groupMetadata(message.chat);
      participants = group?.participants || [];
    } catch { return; }
  }

  if (!message.isAdmin && !message.isCreator) {
    const senderAdmin = participants.some(p =>
      p?.admin && sameIdentity(senderIdentities(message), participantIdentities(p))
    );
    if (senderAdmin) message.isAdmin = true;
  }

  if (!message.isBotAdmin) {
    const botAdmin = participants.some(p =>
      p?.admin && sameIdentity(botIdentities(message), participantIdentities(p))
    );
    if (botAdmin) message.isBotAdmin = true;
  }
}

// Only commands that are KNOWN broken (admin-gated but isAdmin/isBotAdmin fails in LID groups)
// Commands like .tag, .del, .ship, .ginfo already work — do NOT include them.
const NEEDS_FIX = new Set([
  'mute', 'unmute',
  'gpp', 'fullgpp',
  'setdesc', 'setname',
  'setgdesc', 'gdesc', 'setgname', 'gname',
  'rejectall', 'acceptall',
  'listrequest', 'requestjoin', 'rejectjoin', 'acceptjoin',
]);

function getConfigNames(config) {
  return [
    config.pattern, config.cmdname,
    ...(Array.isArray(config.alias) ? config.alias : []),
  ].filter(Boolean).map(n => String(n).toLowerCase().trim());
}

// Wrap both smd and cmd to inject admin-fix middleware
function wrapRegisterFn(origFn, fnName) {
  return function (config, handler) {
    // Only wrap commands from group.smd
    if (config?.filename && config.filename.includes('group.smd') && !config.fromMe) {
      const names = getConfigNames(config);
      if (names.some(n => NEEDS_FIX.has(n))) {
        const origHandler = handler;
        if (typeof origHandler === 'function') {
          config = { ...config };
          // We can't replace the handler here because smd/cmd may store it differently.
          // Instead, set a flag so the dispatch code can fix it.
          config.__saffulAdminFix = true;
          const wrappedHandler = async function (message, text, context) {
            await recheckAdmin(message, context);
            return origHandler.call(this, message, text, context);
          };
          return origFn.call(this, config, wrappedHandler);
        }
      }
    }
    return origFn.call(this, config, handler);
  };
}

// Only patch if these functions exist (they should, since we imported them)
if (typeof smd === 'function') {
  // commands already imported at top
  // Patch the commands array directly: wrap handlers after all plugins load
  setImmediate(() => {
    let patched = 0;
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      const fname = String(cmd.filename || '');
      if (!fname.includes('group.smd')) continue;
      if (cmd.fromMe) continue;

      const names = [
        cmd.pattern, cmd.cmdname,
        ...(Array.isArray(cmd.alias) ? cmd.alias : []),
      ].filter(Boolean).map(n => String(n).toLowerCase().trim());

      if (!names.some(n => NEEDS_FIX.has(n))) continue;

      // Find the handler function property (skip known non-handler keys)
      const SKIP_KEYS = new Set(['filename', 'on', 'fromMe', 'pattern', 'cmdname', 'alias', 'type', 'category', 'desc', 'info', 'use', 'tag', 'react', 'only', 'dontAddCommandList', 'onLeave', 'onAdd']);
      let handlerKey = null;
      let origHandler = null;
      for (const key of Object.keys(cmd)) {
        if (SKIP_KEYS.has(key)) continue;
        if (typeof cmd[key] === 'function') {
          handlerKey = key;
          origHandler = cmd[key];
          break;
        }
      }

      if (!origHandler) continue;

      const fixedHandler = async function (message, text, context) {
        await recheckAdmin(message, context);
        return origHandler.call(this, message, text, context);
      };

      cmd[handlerKey] = fixedHandler;
      patched++;
    }
    if (patched > 0) {
      console.log(`[safful-group-fix] Patched ${patched} admin commands in group.smd`);
    }
  });
}
