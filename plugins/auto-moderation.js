const { cmd } = require('../lib/plugins');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', '.safful-temp', 'automod.json');

function log(msg) {
  process.stderr.write('[safful-automod] ' + msg + '\n');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8') || '{}');
  } catch { return {}; }
}

function saveSettings(data) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log('Save error: ' + e.message);
  }
}

function isCreator(mek) {
  if (mek?.fromMe) return true;
  const ownerNum = String(process.env.SUDO || process.env.OWNER_NUMBER || '').replace(/\D/g, '');
  const senderNum = String(mek?.sender || mek?.key?.participant || '').replace(/\D/g, '');
  return ownerNum && senderNum && senderNum.includes(ownerNum);
}

function isGroupAdmin(mek) {
  if (mek?.fromMe) return true;
  // In groups, participant field with admin status — simplified check
  return false;
}

function chatKey(jid) {
  return String(jid || '').split('@')[0].replace(/[^0-9]/g, '');
}

// ─── .antisticker — Delete stickers in a chat ──────────────────────────
cmd({
  pattern: 'antisticker',
  alias: ['antistk'],
  desc: 'Auto-delete stickers in a chat',
  category: 'automod',
  use: '.antisticker <chat_number|group|off>',
}, async (mek, text, extra) => {
  if (!isCreator(mek)) return mek.reply('*Owner only!*');

  const input = String(text || '').trim().toLowerCase();
  const state = loadSettings();
  const chat = mek.chat;

  if (!input || input === 'status') {
    const chats = Object.keys(state).filter(k => k.includes('antisticker'));
    return mek.reply(
      '*Anti-Sticker Status*\n\n' +
      (chats.length > 0 ? 'Active chats:\n' + chats.map(c => '• ' + c.replace('antisticker:', '')).join('\n') : 'No chats enabled') +
      '\n\n*Usage:* `.antisticker on` or `.antisticker off`'
    );
  }

  const key = 'antisticker:' + chatKey(chat);
  if (input === 'off' || input === 'disable') {
    delete state[key];
    saveSettings(state);
    return mek.reply('*Anti-Sticker* disabled for this chat.');
  }

  state[key] = true;
  saveSettings(state);
  return mek.reply('*Anti-Sticker* enabled for this chat.\nStickers will be auto-deleted.');
});

// ─── .antiimage — Delete images in a chat ──────────────────────────────
cmd({
  pattern: 'antiimage',
  alias: ['antiimg'],
  desc: 'Auto-delete images in a chat',
  category: 'automod',
  use: '.antiimage <on|off>',
}, async (mek, text, extra) => {
  if (!isCreator(mek)) return mek.reply('*Owner only!*');

  const input = String(text || '').trim().toLowerCase();
  const state = loadSettings();
  const chat = mek.chat;

  if (!input || input === 'status') {
    const chats = Object.keys(state).filter(k => k.includes('antiimage'));
    return mek.reply(
      '*Anti-Image Status*\n\n' +
      (chats.length > 0 ? 'Active chats:\n' + chats.map(c => '• ' + c.replace('antiimage:', '')).join('\n') : 'No chats enabled') +
      '\n\n*Usage:* `.antiimage on` or `.antiimage off`'
    );
  }

  const key = 'antiimage:' + chatKey(chat);
  if (input === 'off' || input === 'disable') {
    delete state[key];
    saveSettings(state);
    return mek.reply('*Anti-Image* disabled for this chat.');
  }

  state[key] = true;
  saveSettings(state);
  return mek.reply('*Anti-Image* enabled for this chat.\nImages will be auto-deleted.');
});

// ─── .antivideo — Delete videos in a chat ──────────────────────────────
cmd({
  pattern: 'antivideo',
  alias: ['antivid'],
  desc: 'Auto-delete videos in a chat',
  category: 'automod',
  use: '.antivideo <on|off>',
}, async (mek, text, extra) => {
  if (!isCreator(mek)) return mek.reply('*Owner only!*');

  const input = String(text || '').trim().toLowerCase();
  const state = loadSettings();
  const chat = mek.chat;

  if (!input || input === 'status') {
    const chats = Object.keys(state).filter(k => k.includes('antivideo'));
    return mek.reply(
      '*Anti-Video Status*\n\n' +
      (chats.length > 0 ? 'Active chats:\n' + chats.map(c => '• ' + c.replace('antivideo:', '')).join('\n') : 'No chats enabled') +
      '\n\n*Usage:* `.antivideo on` or `.antivideo off`'
    );
  }

  const key = 'antivideo:' + chatKey(chat);
  if (input === 'off' || input === 'disable') {
    delete state[key];
    saveSettings(state);
    return mek.reply('*Anti-Video* disabled for this chat.');
  }

  state[key] = true;
  saveSettings(state);
  return mek.reply('*Anti-Video* enabled for this chat.\nVideos will be auto-deleted.');
});

// ─── .antibadword — Filter bad words in a chat ─────────────────────────
cmd({
  pattern: 'antibadword',
  alias: ['badword', 'badwords', 'addbadword', 'delbadword'],
  desc: 'Manage bad word filter',
  category: 'automod',
  use: '.antibadword <on|off> or .addbadword <word> or .delbadword <word>',
}, async (mek, text, extra) => {
  if (!isCreator(mek)) return mek.reply('*Owner only!*');

  const input = String(text || '').trim();
  const state = loadSettings();
  const chat = mek.chat;

  // Handle .addbadword
  if (mek.cmdName === 'addbadword' || mek.cmdName === 'badword') {
    const word = input.toLowerCase().trim();
    if (!word) return mek.reply('*Usage:* `.addbadword <word>`');
    
    const key = 'badwords:' + chatKey(chat);
    if (!state[key]) state[key] = [];
    if (!state[key].includes(word)) {
      state[key].push(word);
      saveSettings(state);
      return mek.reply('*Added to bad words:* `' + word + '`\nTotal: ' + state[key].length + ' words');
    }
    return mek.reply('*`' + word + '`* is already in the list.');
  }

  // Handle .delbadword
  if (mek.cmdName === 'delbadword') {
    const word = input.toLowerCase().trim();
    if (!word) return mek.reply('*Usage:* `.delbadword <word>`');
    
    const key = 'badwords:' + chatKey(chat);
    if (state[key]) {
      state[key] = state[key].filter(w => w !== word);
      saveSettings(state);
      return mek.reply('*Removed:* `' + word + '`\nRemaining: ' + state[key].length);
    }
    return mek.reply('*No bad words set for this chat.*');
  }

  // Handle .antibadword on/off/status
  const lower = input.toLowerCase();
  if (!lower || lower === 'status') {
    const key = 'badwords:' + chatKey(chat);
    const words = state[key] || [];
    return mek.reply(
      '*Anti-Badword Status*\n\n' +
      'Words: ' + (words.length > 0 ? words.map(w => '`' + w + '`').join(', ') : 'None set') +
      '\n\n*Commands:*\n' +
      '• `.antibadword on` — enable filter\n' +
      '• `.antibadword off` — disable filter\n' +
      '• `.addbadword <word>` — add word\n' +
      '• `.delbadword <word>` — remove word'
    );
  }

  const key = 'antibadword:' + chatKey(chat);
  if (lower === 'off' || lower === 'disable') {
    delete state[key];
    saveSettings(state);
    return mek.reply('*Anti-Badword* disabled for this chat.');
  }

  state[key] = true;
  saveSettings(state);
  return mek.reply('*Anti-Badword* enabled for this chat.\nBad words will be auto-deleted.');
});

module.exports = { loadSettings, SETTINGS_FILE };
