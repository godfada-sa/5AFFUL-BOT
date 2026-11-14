'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
const baileys = require('@whiskeysockets/baileys')
const root = path.resolve(__dirname, '..')
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this } }
const settle = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), 'asynchronous media operation completed')
}

function setup(t, previous) {
  const temp = previous || fs.mkdtempSync(path.join(os.tmpdir(), 'ghana-test-'))
  fs.mkdirSync(path.join(temp, 'lib'), { recursive: true })
  if (!previous) t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const registry = [], cache = new Map(), state = { downloads: [], fail: false, global: {}, intervals: [] }
  const env = { SUDO: '233240000001,233240000002',
    SAFFUL_CALLGUARD_FILE: path.join(temp, 'call.json'), SAFFUL_ANTIVIEWONCE_FILE: path.join(temp, 'avo.json') }
  const fakeProcess = { env, stderr: { write() {} }, stdout: { write() {} } }
  const fakeModule = { _load(request) { return request === './serialized.js'
    ? { smsg: async () => ({ isCreator: false }) }
    : { default: () => socket() } } }
  function load(relative) {
    const filename = path.resolve(root, relative)
    if (cache.has(filename)) return cache.get(filename)
    const mod = { exports: {} }, realRequire = createRequire(filename)
    const req = name => {
      if (name === 'module') return fakeModule
      if (name === './safful-protection') return load('lib/safful-protection.js')
      if (name === './safful-mobile-notifications') return () => {}
      if (name === '../plugins/statusauto.smd') return { attach: socket => { socket.__saffulAutoViewAttached = true } }
      if (name === '@whiskeysockets/baileys') return { ...baileys, downloadContentFromMessage: async (media, kind) => {
        state.downloads.push({media, kind})
        if (media.directPath === '/expired') throw Object.assign(new Error('expired'), { status: 410 })
        if (state.fail) throw new Error('network unavailable')
        return (async function* () { yield Buffer.from('media bytes') })()
      } }
      if (/lib\/plugins$/.test(name)) return { commands: registry, cmd: (options, fn) => registry.push({ ...options, function: fn }) }
      if (/safful-mode$/.test(name)) return { isOwner: (m, meta) => Boolean(m.fromMe || m.key?.fromMe || meta?.isCreator) }
      if (name.startsWith('.') && /(?:safful-identities|safful-viewonce-detector|safful-call-guard|antiviewonce)$/.test(name)) return load(path.relative(root, path.resolve(path.dirname(filename), name + '.js')))
      return realRequire(name)
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: req, module: mod, exports: mod.exports,
      __dirname: relative === 'lib/safful-protection.js' ? path.join(temp, 'lib') : path.dirname(filename), __filename: filename, Buffer, structuredClone, process: fakeProcess,
      global: state.global, console, setTimeout, clearTimeout,
      setInterval: fn => { state.intervals.push(fn); return { unref() {}, fn } },
      clearInterval: timer => { if (timer) timer.cleared = true } }, { filename })
    cache.set(filename, mod.exports)
    return mod.exports
  }
  function socket(buffered = false) {
    const calls = [], sent = [], blocks = []
    return { ev: buffered ? baileys.makeEventBuffer(logger) : new EventEmitter(), ws: new EventEmitter(),
      user: { id: '233240000009:4@s.whatsapp.net', lid: '900009@lid' }, calls, sent, blocks,
      signalRepository: { lidMapping: { getPNForLID: async lid => ({ '900001@lid': '233240000001@s.whatsapp.net', '900003@lid': '233240000003@s.whatsapp.net' })[lid] } },
      rejectCall: async (...args) => { calls.push(args) }, updateBlockStatus: async (...args) => { blocks.push(args) },
      sendMessage: async (...args) => { sent.push(args) }, groupMetadata: async () => ({ subject: 'Friends', participants: [{id: '233240000003@s.whatsapp.net'}] }) }
  }
  return { load, registry, state, socket, fakeModule, env, temp }
}
function media(id='one', kind='imageMessage') { return { key: { id, remoteJid: '900003@lid', remoteJidAlt:'233240000003@s.whatsapp.net', fromMe:false }, message: { viewOnceMessageV2: { message: { [kind]: { viewOnce:true, directPath:'/valid', mediaKey:Buffer.alloc(32), caption:'hello' } } } } } }

test('E2E: anti-delete delivers the revoked attachment and notice to the first configured DM', async t => {
  const h = setup(t), protection = h.load('lib/safful-protection.js'), s = h.socket()
  protection.setAntiDelete(true)
  protection(s)
  for (const [kind, details] of Object.entries({
    sticker: { mimetype: 'image/webp' }, audio: { mimetype: 'audio/ogg', ptt: true },
    image: { caption: 'image' }, video: { caption: 'video' },
    document: { fileName: 'invoice.pdf', mimetype: 'application/pdf' },
  })) {
    const key = { id: 'deleted-' + kind, remoteJid: 'group@g.us', participant: '233240000003@s.whatsapp.net' }
    const original = { key, message: { messageContextInfo: {}, [kind+'Message']: { ...details, directPath: '/valid' } } }
    // No relay transport: exercise the actual download/resend fallback.
    s.ev.emit('messages.upsert', { messages: [original] })
    await settle()
    s.ev.emit('messages.update', [{ key, update: { messageStubType: 1 } }])
    await settle()
    const batch = s.sent.splice(0)
    assert.equal(batch.length, 2, kind)
    assert.ok(batch.every(([to]) => to === '233240000001@s.whatsapp.net'))
    assert.equal(batch[0][1][kind].toString(), 'media bytes')
    for (const [field, value] of Object.entries(details)) {
      if (kind !== 'sticker') assert.equal(batch[0][1][field], value)
    }
    assert.ok(batch[1][1].text)
    let relayed
    await protection.reforwardDeletedMessage({ relayMessage: async (_, content) => { relayed = content } }, batch[0][0], original)
    assert.ok(relayed[kind+'Message'], 'relay must select media over metadata')
  }
})

test('E2E: anti-delete recovers received view-once photos, videos and voice notes after deletion', async t => {
  const h = setup(t), protection = h.load('lib/safful-protection.js'), s = h.socket(true)
  protection.setAntiDelete(true)
  protection.installSocketRawCapture(s)
  protection(s)
  t.after(() => s.ev.flush())
  for (const [wrapper, kind] of [
    ['viewOnceMessage', 'imageMessage'], ['viewOnceMessageV2', 'videoMessage'],
    ['viewOnceMessageV2Extension', 'audioMessage'], ['key-flag', 'imageMessage'],
    ['viewOnceMessageV2Extension', 'ptvMessage'],
  ]) {
    h.state.fail = false
    s.ev.buffer()
    const downloadsBefore = h.state.downloads.length
    const raw = media('deleted-' + wrapper + kind, kind)
    const content = { [kind]: {
      directPath: '/valid', viewOnce: true, caption: 'original caption',
      mimetype: kind === 'audioMessage' ? 'audio/ogg' : undefined, ptt: kind === 'audioMessage',
    } }
    raw.message = { [wrapper]: { message: content } }
    if (wrapper === 'key-flag') {
      raw.message = content
      raw.key.isViewOnce = true
      delete content[kind].viewOnce
    }
    s.ev.emit('messages.upsert', { type: 'notify', messages: [raw] })
    await until(() => h.state.downloads.length > downloadsBefore)
    h.state.fail = true // recovery must now use the previously captured bytes
    raw.message = { conversation: 'serializer replaced the original' }
    s.ev.flush()
    const cached = await protection.readCapturedViewOnce(raw.key.remoteJid, raw.key.id)
    assert.equal(cached.bytes.toString(), 'media bytes', 'kk can reuse the original capture')
    assert.equal(await protection.readCapturedViewOnce('different@g.us', raw.key.id), null, 'no ID-only cross-chat recovery')
    s.ev.emit('messages.update', [{ key: raw.key, update: { message: null, messageStubType: 1 } }])
    await until(() => s.sent.length >= 2)
    const batch = s.sent.splice(0), field = kind === 'ptvMessage' ? 'video' : kind.replace('Message', '')
    assert.equal(batch.length, 2, wrapper + ': attachment and notice')
    assert.ok(batch.every(([to]) => to === '233240000001@s.whatsapp.net'))
    assert.equal(batch[0][1][field].toString(), 'media bytes')
    assert.equal(batch[0][1].viewOnce, undefined)
    if (kind === 'audioMessage') assert.equal(batch[0][1].ptt, true)
  }
  s.ev.flush()
})

test('kk can read a key-flag-only view-once capture after a restart', async t => {
  const h = setup(t), protection = h.load('lib/safful-protection.js'), s = h.socket()
  protection.installSocketRawCapture(s)
  const raw = { key: { id: 'restart-key-flag', remoteJid: '900003@lid', isViewOnce: true },
    message: { imageMessage: { directPath: '/valid', mediaKey: Buffer.alloc(32) } } }
  s.ev.emit('messages.upsert', { messages: [raw] })
  const initial = await protection.readCapturedViewOnce(raw.key.remoteJid, raw.key.id)
  assert.equal(initial.bytes.toString(), 'media bytes')
  const restarted = setup(t, h.temp).load('lib/safful-protection.js')
  restarted.installEarlyCaptureHook()
  const restored = await restarted.readCapturedViewOnce(raw.key.remoteJid, raw.key.id)
  assert.equal(restored?.bytes?.toString(), 'media bytes')
})

test('E2E: antiviewonce command enforces permissions, contact rules and DM delivery', async t => {
  const h = setup(t), avo = h.load('plugins/antiviewonce.js'), s = h.socket()
  avo.attach(s)
  const run = h.registry.find(c => c.pattern === 'antiviewonce').function
  const replies = [], owner = { fromMe: true, reply: async msg => replies.push(msg) }
  await run({ reply: owner.reply }, 'on', { Void: s })
  assert.match(replies.at(-1), /Owner only/)
  await run(owner, '233240000003', { Void: s })
  for (const kind of ['image', 'audio', 'video']) {
    s.ev.emit('messages.upsert', { messages: [media(kind, kind+'Message')] })
    await settle()
    assert.equal(s.sent.at(-1)[0], '233240000001@s.whatsapp.net')
    assert.equal(s.sent.at(-1)[1][kind].toString(), 'media bytes')
  }
  await run(owner, 'off 233240000003', { Void: s })
  s.ev.emit('messages.upsert', { messages: [media('off')] })
  await settle()
  assert.equal(s.sent.length, 3)
  await run(owner, 'on', { Void: s })
  s.ev.emit('messages.upsert', { messages: [media('global')] })
  await settle()
  assert.equal(s.sent.length, 4)
})

test('PN resolution never invents a telephone from a LID; group sender uses participantAlt', async t => {
  const h=setup(t), ids=h.load('lib/safful-identities.js'), s=h.socket()
  assert.equal(ids.phoneJid('900003@lid'),'')
  assert.equal(ids.phoneJid('233240000003:4@s.whatsapp.net'),'233240000003@s.whatsapp.net')
  assert.equal(await ids.resolvePhone(s,'900003@lid'),'233240000003@s.whatsapp.net')
  assert.equal(await ids.resolvePhone(s,'900004@lid'),'')
  assert.equal(await ids.isOperator({key:{remoteJid:'group@g.us',participant:'900001@lid',participantAlt:'233240000001@s.whatsapp.net'}},{},s),true)
})

test('VCF deduplicates mapped contacts, skips hidden numbers and escapes/folds Unicode', async t => {
  const h=setup(t), v=h.load('plugins/vcf.js'), s=h.socket()
  const result=await v.collectContacts(s,{subject:'Team',participants:[{id:'900003@lid'}, {id:'233240000003@s.whatsapp.net'}, {id:'900004@lid'}, {id:'900005@lid',phoneNumber:'233240000005@s.whatsapp.net'}]},{})
  assert.equal(result.rows.length,2); assert.equal(result.unresolved,1)
  const file=v.makeVcf([{name:'é'.repeat(100)+';Test,Name\nNext',number:'233240000003'}]).toString()
  assert.ok(file.includes('TEL;TYPE=CELL:+233240000003'))
  assert.ok(file.replace(/\r\n /g,'').includes('\\;Test\\,Name\\nNext'))
  assert.ok(file.split('\r\n').every(line=>Buffer.byteLength(line)<=75))
  const csv=v.makeCsv([{name:'=HYPERLINK("bad")',number:'233240000003',role:'member'}]).toString()
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes("'+233240000003"))
})

test('silent group export always delivers only to owner, including when invoked by a member', async t => {
  const h=setup(t), v=h.load('plugins/vcf.js'), s=h.socket(), replies=[]
  const m={chat:'team@g.us',sender:'900001@lid',key:{remoteJid:'team@g.us',participant:'900001@lid'},reply:async x=>replies.push(x)}
  await v.exportContacts(m,'',{Void:s}); assert.equal(s.sent[0][0],'233240000001@s.whatsapp.net'); assert.ok(s.sent[0][1].document)
  await v.exportContacts({...m,fromMe:true},'csv sudo',{Void:s}); assert.equal(s.sent[1][0],'233240000001@s.whatsapp.net'); assert.equal(s.sent[1][1].mimetype,'text/csv')
  await v.exportContacts({...m,sender:'900004@lid',key:{remoteJid:'team@g.us',participant:'900004@lid'}},'',{Void:s})
  assert.equal(s.sent.length,3); assert.ok(s.sent.every(([jid])=>jid==='233240000001@s.whatsapp.net')); assert.equal(replies.length,0)
})

test('call guard handles callerPn, mapped LID, ringing and DND on fresh sockets without duplicates', async t => {
  const h=setup(t), guard=h.load('plugins/safful-call-guard.js'), s=h.socket()
  guard.saveSettings({dnd:false,reject:['233240000003'],block:[]}); guard.attach(s); guard.attach(s)
  s.ws.emit('CB:call',{attrs:{from:'900003@lid'},content:[{tag:'offer',attrs:{'call-id':'c1','call-creator':'900003@lid',caller_pn:'233240000003@s.whatsapp.net'}}]})
  s.ev.emit('call',[{id:'c1',from:'900003@lid',status:'offer',callerPn:'233240000003@s.whatsapp.net'}]); await settle()
  assert.equal(s.calls.length,1); assert.equal(s.calls[0][0],'c1'); assert.equal(s.calls[0][1],'900003@lid')
  s.ev.emit('call',[{id:'c2',from:'900003@lid',status:'ringing'}]); await settle(); assert.equal(s.calls.length,2)
  guard.saveSettings({dnd:true,reject:[],block:[]}); const replacement=h.socket(); guard.attach(replacement)
  replacement.ev.emit('call',[{id:'c3',from:'999999@lid',status:'offer'},{id:'old',from:'999999@lid',status:'offer',offline:true},{id:'own',from:replacement.user.lid,status:'offer'}]); await settle()
  assert.equal(replacement.calls.length,1)
})

test('block command performs real block/unblock and failed rejection can retry', async t => {
  const h=setup(t), guard=h.load('plugins/safful-call-guard.js'), s=h.socket(), replies=[]
  const m={fromMe:true,reply:async x=>replies.push(x)}, command=h.registry.find(c=>c.pattern==='blockcall').function
  await command(m,'233240000003',{Void:s}); assert.equal(s.blocks[0][1],'block')
  await command(m,'del 233240000003',{Void:s}); assert.equal(s.blocks[1][1],'unblock'); assert.equal(guard.loadSettings().block.length,0)
  guard.saveSettings({dnd:true,reject:[],block:[]}); guard.attach(s)
  s.rejectCall=async()=>{throw new Error('offline')}; s.ev.emit('call',[{id:'retry',from:'900003@lid',status:'offer'}]); await settle()
  s.rejectCall=async(...args)=>s.calls.push(args); s.ev.emit('call',[{id:'retry',from:'900003@lid',status:'ringing'}]); await settle(); assert.equal(s.calls.length,1)
})

test('detector excludes ordinary and quoted media; supports nested voice notes and key flag', t => {
  const h=setup(t), d=h.load('lib/safful-viewonce-detector.js')
  assert.equal(d.detectViewOnce({message:{imageMessage:{}}}),null)
  assert.equal(d.detectViewOnce({message:{extendedTextMessage:{contextInfo:{quotedMessage:media().message}}}}),null)
  assert.equal(d.detectViewOnce({message:{deviceSentMessage:{message:{ephemeralMessage:{message:media('a','audioMessage').message}}}}}).type,'audioMessage')
  assert.equal(d.detectViewOnce({key:{isViewOnce:true},message:{videoMessage:{}}}).type,'videoMessage')
  assert.equal(d.detectViewOnce({message:{editedMessage:{message:{viewOnceMessageV2Extension:{message:{ptvMessage:{}}}}}}}).type,'ptvMessage')
})

test('raw capture survives actual Baileys event buffering, serializer mutation and duplicate updates', async t => {
  const h=setup(t), avo=h.load('plugins/antiviewonce.js'), s=h.socket(true)
  avo.saveSettings({global:true,contacts:[]}); avo.attach(s); s.ev.buffer()
  const message=media('buffered'); s.ev.emit('messages.upsert',{type:'notify',messages:[message]})
  message.message={conversation:'mutated'}; await settle(); assert.equal(s.sent.length,1)
  s.ev.flush(); s.ev.emit('messages.update',[{key:media('buffered').key,update:{message:media('buffered').message}}]); await settle(); assert.equal(s.sent.length,1)
  assert.equal(s.sent[0][0],'233240000001@s.whatsapp.net')
  assert.equal(s.sent[0][1].viewOnce,undefined)
})

test('expired URL reaches re-upload fallback; failed messages can succeed on later update', async t => {
  const h=setup(t), avo=h.load('plugins/antiviewonce.js'), s=h.socket()
  avo.saveSettings({global:false,contacts:['233240000003']}); avo.attach(s)
  const msg=media('expired','audioMessage'); msg.message.viewOnceMessageV2.message.audioMessage.directPath='/expired'
  let reuploads=0; s.updateMediaMessage=async m=>{reuploads++;m.message.audioMessage.directPath='/fresh';return m}
  s.ev.emit('messages.upsert',{messages:[msg]}); await settle(); assert.equal(reuploads,1); assert.equal(s.sent.length,1); assert.ok(s.sent[0][1].audio); assert.equal(h.state.downloads[1].kind,'audio')
  h.state.fail=true; s.ev.emit('messages.upsert',{messages:[media('retry')]}); await settle(); assert.equal(avo.stats.failed,1)
  h.state.fail=false; s.ev.emit('messages.update',[{key:media('retry').key,update:{message:media('retry').message}}]); await settle(); assert.equal(s.sent.length,2)
})

test('expired media accepts a refreshed payload returned inside a modern wrapper', async t => {
  const h=setup(t), avo=h.load('plugins/antiviewonce.js'), s=h.socket()
  const raw=media('wrapped-refresh','videoMessage')
  raw.message.viewOnceMessageV2.message.videoMessage.directPath='/expired'
  s.updateMediaMessage=async message=>({key:message.key,message:{ephemeralMessage:{message:{viewOnceMessageV2Extension:{message:{videoMessage:{directPath:'/fresh',caption:'updated'}}}}}}})
  const detected=avo.unwrapViewOnce(raw.message)
  const bytes=await avo.downloadViewOnce(s,raw,detected)
  assert.equal(bytes.toString(),'media bytes')
  assert.equal(h.state.downloads.length,2)
  assert.equal(h.state.downloads[1].media.directPath,'/fresh')
})

test('unavailable fanouts are counted without pretending to recover media; pause suppresses capture', async t => {
  const h=setup(t), avo=h.load('plugins/antiviewonce.js'), s=h.socket(); avo.saveSettings({global:true,contacts:[]}); avo.attach(s)
  s.ws.emit('CB:message',{attrs:{id:'hidden',from:'900003@lid'},content:[{tag:'unavailable',attrs:{type:'view_once_unavailable_fanout'}}]}); await settle()
  assert.equal(avo.stats.unavailable,1); assert.equal(s.sent.length,0); assert.equal(h.state.downloads.length,0)
  h.state.global.saffulChatbotPaused=true; s.ev.emit('messages.upsert',{messages:[media('paused')]}); await settle(); assert.equal(s.sent.length,0)
})

test('socket factory attaches on every reconnect and serializer recognizes sudo LID before private gate', async t => {
  const h=setup(t), hooks=h.load('lib/safful-feature-hooks.js'); hooks.install(); hooks.install()
  const parent={filename:path.join(root,'lib/smd.js')}
  const factory=h.fakeModule._load('@whiskeysockets/baileys',parent).default
  const first=factory({}), second=factory({})
  assert.ok(first.__saffulProtectionAttached); assert.ok(second.__saffulProtectionAttached)
  assert.ok(first.__saffulAntiViewOnceAttached); assert.ok(second.__saffulAntiViewOnceAttached)
  assert.ok(first.__saffulAutoViewAttached); assert.ok(second.__saffulAutoViewAttached)
  assert.equal(h.state.global.__saffulLatestSocket,second)
  const serializer=h.fakeModule._load('./serialized.js',parent)
  const owner=await serializer.smsg(second,{key:{remoteJid:'team@g.us',participant:'900001@lid'}})
  assert.equal(owner.isCreator,true)
  const member=await serializer.smsg(second,{key:{remoteJid:'team@g.us',participant:'900003@lid'}})
  assert.equal(member.isCreator,false)
})

test('late payload replaces unavailable retry entry and survives a concurrent retry cycle', async t => {
  const h=setup(t), avo=h.load('plugins/antiviewonce.js'), s=h.socket()
  avo.saveSettings({global:true,contacts:[]}); avo.attach(s)
  s.ws.emit('CB:message',{attrs:{id:'late',from:'900003@lid'},content:[{tag:'unavailable',attrs:{type:'view_once_unavailable_fanout'}}]}); await settle()
  h.state.fail=true
  s.ev.emit('messaging-history.set',{messages:[media('late')]}); await settle()
  const key='900003@lid:late'; assert.ok(avo.retryQueue.get(key).raw.message)
  h.state.fail=false; avo.runRetryCycle(); avo.runRetryCycle(); await settle()
  assert.equal(s.sent.length,1); assert.equal(avo.stats.recovered,1); assert.equal(avo.retryQueue.size,0)
})
