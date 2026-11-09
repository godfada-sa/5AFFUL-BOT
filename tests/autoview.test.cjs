'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm')
const { EventEmitter } = require('events')

function setup(t, saved) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoview-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  if (saved) fs.writeFileSync(file, JSON.stringify(saved))
  let now = 100000
  const timers = new Map(), globals = {}, commands = []
  const env = { SAFFUL_AUTOVIEW_FILE: file, STATUS_VIEW_INTERVAL: '0' }
  function load(relative, mocks) {
    const filename = path.resolve(__dirname, '..', relative), module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: name => name in mocks ? mocks[name] : require(name), module, exports: module.exports,
      __dirname: path.dirname(filename), __filename: filename,
      process: { env }, global: globals, console: { log() {}, error() {} },
      Date: class extends Date { static now() { return now } },
      setTimeout: (fn, delay) => { const timer = { unref() {} }; timers.set(timer, {fn,at:now+delay}); return timer },
      clearTimeout: timer => timers.delete(timer),
    }, { filename })
    return module.exports
  }
  const plugins = { smd() {}, cmd: (options, fn) => commands.push({options,fn}) }
  const engine = load('plugins/statusauto.smd', {'../lib/plugins':plugins,'../lib/safful-status-save':{attach(){}}})
  load('plugins/autoview.js', {'../lib/plugins':plugins,'./statusauto.smd':engine,
    '../lib/safful-identities':{isOperator:async m=>Boolean(m.fromMe)}})
  function socket() {
    const s={ev:new EventEmitter(), receipts:[], selfReceipts:[], sendReceipt:async(...args)=>
      s.receipts.push(args), sendNode:async node=>s.selfReceipts.push(
        [node.attrs.to,node.attrs.participant,[node.attrs.id],node.attrs.type,node.attrs.class])}
    return s
  }
  async function tick(ms) {
    now+=ms
    for(let count=0;count<20;count++) {
      const next=[...timers].find(([,task])=>task.at<=now)
      if(!next) return
      timers.delete(next[0]); next[1].fn()
      await new Promise(resolve=>setImmediate(resolve))
    }
    throw new Error('Timer loop did not settle')
  }
  return {engine,socket,tick,globals,commands,file}
}
function status(id) { return {key:{id,remoteJid:'status@broadcast',participant:'900003@lid',participantAlt:'233240000003@s.whatsapp.net',fromMe:false},message:{conversation:'status'}} }
const settle = () => new Promise(resolve=>setImmediate(resolve))

test('E2E: autoview command to decoded WhatsApp wire receipts for a top-level status', async t => {
  const h = setup(t)
  const { default: makeSocket, initAuthCreds, decodeBinaryNode, NOISE_WA_HEADER } = require('@whiskeysockets/baileys')
  const { WebSocketClient } = require('@whiskeysockets/baileys/lib/Socket/Client/websocket.js')
  const frames = []
  t.mock.method(WebSocketClient.prototype, 'connect', function () {
    this.socket = { readyState: 1, send(bytes, done) { frames.push(bytes); done() } }
  })
  t.mock.method(WebSocketClient.prototype, 'close', async function () { this.socket = null })
  const creds = initAuthCreds()
  creds.me = { id: '1000@s.whatsapp.net' }
  const socket = makeSocket({ auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
    logger: require('pino')({ level: 'silent' }) })
  t.after(() => socket.end())
  require('../lib/safful-reconnect-watchdog').watch(socket)
  require('../lib/safful-mobile-notifications')(socket)
  await h.commands[0].fn({fromMe:true,reply:async()=>{}}, 'on', {Void:socket})
  const attrs = { id:'wire', from:'status@broadcast', participant:'900003@lid', type:'media' }
  const node = { tag:'status', attrs, content:[{tag:'enc',attrs:{type:'skmsg'}}] }
  socket.ws.emit('CB:status,from:status@broadcast',node)
  socket.ws.emit('CB:status',node)
  await settle()
  const packets = await Promise.all(frames.map((frame,i) => decodeBinaryNode(frame.subarray(3+(i===0?NOISE_WA_HEADER.length:0)))))
  assert.equal(packets.length,3)
  assert.equal(packets.filter(p=>p.tag==='ack' && p.attrs.class==='status').length,1)
  const reads=packets.filter(p=>p.tag==='receipt' && p.attrs.type==='read')
  assert.equal(reads.length,2)
  assert.ok(reads.some(p=>p.attrs.class==='status'))
  assert.ok(reads.every(p=>p.attrs.id==='wire' && p.attrs.to==='status@broadcast' && p.attrs.participant==='900003@lid'))
})

test('E2E: personal status packet produces transport ACK and configured view receipts, once across redelivery', async t => {
  const h=setup(t),s=h.socket(),acks=[]
  s.ws=new EventEmitter()
  s.sendMessageAck=async node=>acks.push(node.attrs.id)
  s.user={ id:'123@s.whatsapp.net',lid:'456@lid' }
  h.engine.attach(s)
  require('../lib/safful-reconnect-watchdog').watch(s)
  function deliver(id, participant='900003@lid') {
    const node={ tag:'status', attrs:{id,from:'status@broadcast',participant,type:'media'}, content:[{tag:'enc'}] }
    s.ws.emit('CB:status,from:status@broadcast',node)
    s.ws.emit('CB:status',node)
  }
  deliver('disabled'); assert.equal(s.receipts.length,0)
  h.engine.setMode('1'); deliver('delayed')
  await h.tick(59999); assert.equal(s.receipts.length,0)
  await h.tick(1); assert.equal(s.receipts.length,1)
  h.engine.setMode('on'); deliver('wire')
  s.ev.emit('messages.upsert',{messages:[status('wire')]})
  deliver('self','456@lid');deliver('newsletter','123@newsletter')
  await settle()
  assert.equal(s.receipts.length,2); assert.equal(s.selfReceipts.length,2)
  assert.deepEqual(s.selfReceipts.at(-1),['status@broadcast','900003@lid',['wire'],'read','status'])
  assert.deepEqual(acks,['disabled','delayed','wire','self','newsletter'])
})

test('on views immediately using correct broadcast receipt; duplicates are skipped',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  s.ev.emit('messages.upsert',{messages:[status('a')]});await settle()
  assert.equal(s.receipts.length,1);assert.equal(s.receipts[0][0],'status@broadcast');assert.equal(s.receipts[0][1],'900003@lid');assert.equal(s.receipts[0][3],'read')
  assert.equal(s.selfReceipts.length,1);assert.equal(s.selfReceipts[0][3],'read')
  assert.equal(s.selfReceipts[0][1],'900003@lid');assert.equal(s.selfReceipts[0][4],'status')
  s.ev.emit('messages.upsert',{messages:[status('a')]});await settle();assert.equal(s.receipts.length,1)
})

test('1-10 minute delays are accepted; delay waits, off cancels and zero changes nothing',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s)
  for(let i=1;i<=10;i++)assert.equal(h.engine.setMode(String(i)),String(i))
  h.engine.setMode('1');s.ev.emit('messages.upsert',{messages:[status('delayed')]})
  await h.tick(59999);assert.equal(s.receipts.length,0)
  await h.tick(1);assert.equal(s.receipts.length,1)
  s.ev.emit('messages.upsert',{messages:[status('cancelled')]});h.engine.setMode('off')
  await h.tick(600000);assert.equal(s.receipts.length,1)
  assert.throws(()=>h.engine.setMode('0'));assert.equal(h.engine.getMode(),'off')
  assert.throws(()=>h.engine.setMode('11'));assert.throws(()=>h.engine.setMode('1.5'))
})

test('switching to on views queued statuses; pause prevents delayed viewing until resumed',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('10')
  s.ev.emit('messages.upsert',{messages:[status('switch')]});h.engine.setMode('on');await h.tick(0);assert.equal(s.receipts.length,1)
  h.engine.setMode('1');s.ev.emit('messages.upsert',{messages:[status('pause')]});h.globals.saffulChatbotPaused=true
  await h.tick(60000);assert.equal(s.receipts.length,1)
  h.globals.saffulChatbotPaused=false;await h.tick(1000);assert.equal(s.receipts.length,2)
})

test('overlapping instant batches do not duplicate receipts; failures retry on replacement socket',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  let release;const gate=new Promise(resolve=>{release=resolve})
  s.sendReceipt=async(...args)=>{(args[3]==='read-self'?s.selfReceipts:s.receipts).push(args);await gate}
  s.ev.emit('messages.upsert',{messages:[status('one')]});s.ev.emit('messages.upsert',{messages:[status('two')]})
  assert.equal(s.receipts.length,1);release();await settle();await h.tick(0);assert.equal(s.receipts.length,2)
  s.sendReceipt=async()=>{throw new Error('connection lost')}
  s.ev.emit('messages.upsert',{messages:[status('retry')]});await settle()
  s.ev.emit('connection.update',{connection:'close'})
  const replacement=h.socket();h.engine.attach(replacement);replacement.ev.emit('connection.update',{connection:'open'})
  await h.tick(30000);assert.equal(replacement.receipts.length,1)
})

test('legacy off/delay settings load; command on/off persist and rejects zero or unauthorized users',async t=>{
  const h=setup(t,{minutes:0}),s=h.socket(),replies=[]
  assert.equal(h.engine.getMode(),'off')
  const run=h.commands[0].fn,m={fromMe:true,reply:async text=>replies.push(text)}
  await run(m,'on',{Void:s});assert.equal(h.engine.getMode(),'instant');assert.equal(JSON.parse(fs.readFileSync(h.file)).mode,'instant')
  await run(m,'0',{Void:s});assert.equal(h.engine.getMode(),'instant');assert.match(replies.at(-1),/no longer supported/)
  await run({fromMe:false,reply:m.reply},'off',{Void:s,ownerNumber:'233240000001'});assert.equal(h.engine.getMode(),'instant')
  await run(m,'off',{Void:s});assert.equal(h.engine.getMode(),'off')
  const delayed=setup(t,{minutes:7});assert.equal(delayed.engine.getMode(),'7')
})

test('status-specific receipt retries without duplicating the generic author receipt',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  let failSelf=true
  s.sendNode=async node=>{
    if(failSelf)throw new Error('sync unavailable')
    s.selfReceipts.push(node)
  }
  s.ev.emit('messages.upsert',{messages:[status('self-retry')]});await settle()
  assert.equal(s.receipts.length,1);assert.equal(s.selfReceipts.length,0)
  assert.equal(h.engine._pending.size,1)
  failSelf=false;await h.tick(30000)
  assert.equal(s.receipts.length,1);assert.equal(s.selfReceipts.length,1)
  assert.equal(h.engine._pending.size,0)
})

test('status-class wire supports PN authors without inventing identities or reading private chats',async t=>{
  const h=setup(t),s=h.socket();h.engine.attach(s);h.engine.setMode('on')
  const incoming=status('pn');incoming.key.participant='233240000003:2@s.whatsapp.net';delete incoming.key.participantAlt
  s.ev.emit('messages.upsert',{messages:[incoming]});await settle()
  assert.equal(s.selfReceipts[0][0],'status@broadcast')
  assert.equal(s.selfReceipts[0][1],'233240000003@s.whatsapp.net')
  assert.equal(s.selfReceipts[0][4],'status')
  s.ev.emit('messages.upsert',{messages:[{...status('dm'),key:{...incoming.key,id:'dm',remoteJid:'233240000003@s.whatsapp.net'}}]})
  await settle();assert.equal(s.selfReceipts.length,1)
})

test('missing status transport does not pretend owner-side sync completed',async t=>{
  const h=setup(t),s=h.socket(),updates=[];delete s.sendNode
  s.ev.on('messages.update',items=>updates.push(...items));h.engine.attach(s);h.engine.setMode('on')
  s.ev.emit('messages.upsert',{messages:[status('unsupported')]});await settle()
  assert.equal(s.receipts.length,1);assert.equal(updates.length,0)
  assert.equal(h.engine._pending.size,1)
  const replacement=h.socket();h.engine.attach(replacement)
  await h.tick(30000)
  assert.equal(replacement.receipts.length,0);assert.equal(replacement.selfReceipts[0][4],'status')
  assert.equal(h.engine._pending.size,0)
})

test('status-class receipt retries without repeating generic author read and updates local store only on success',async t=>{
  const h=setup(t),s=h.socket(),updates=[];h.engine.attach(s);h.engine.setMode('on')
  s.ev.on('messages.update',items=>updates.push(...items))
  let unavailable=true
  s.sendNode=async node=>{
    if(unavailable)throw new Error('transport unavailable')
    s.selfReceipts.push(node)
  }
  const incoming=status('mapped');delete incoming.key.participantAlt
  s.ev.emit('messages.upsert',{messages:[incoming]});await settle()
  assert.equal(s.receipts.length,1);assert.equal(s.selfReceipts.length,0);assert.equal(updates.length,0)
  unavailable=false;await h.tick(30000)
  assert.equal(s.receipts.length,1);assert.equal(s.selfReceipts[0].attrs.participant,'900003@lid')
  assert.equal(s.selfReceipts[0].attrs.class,'status')
  assert.equal(updates[0].key.id,'mapped');assert.equal(updates[0].update.statusAlreadyViewed,true)
})

test('already-viewed statuses are skipped and readMessages fallback also sends status-class receipt',async t=>{
  const h=setup(t),s=h.socket(),reads=[],updates=[]
  delete s.sendReceipt;s.readMessages=async keys=>reads.push(...keys)
  s.ev.on('messages.update',items=>updates.push(...items))
  h.engine.attach(s);h.engine.setMode('on')
  s.ev.emit('messages.upsert',{messages:[{...status('viewed'),statusAlreadyViewed:true},status('new')]});await settle()
  assert.equal(reads.length,1);assert.equal(reads[0].id,'new')
  assert.equal(reads[0].participant,'900003@lid');assert.equal(updates.length,1)
  assert.equal(s.selfReceipts[0][4],'status')
})

test('actual Baileys receipt encoder preserves broadcast routing through the DM notification guard',async t=>{
  const h=setup(t),s=h.socket(),nodes=[]
  const baileysDir=path.dirname(require.resolve('@whiskeysockets/baileys'))
  const source=fs.readFileSync(path.join(baileysDir,'Socket/messages-send.js'),'utf8')
  const start=source.indexOf('const sendReceipt = async'),end=source.indexOf('/** Correctly bulk send receipts',start)
  assert.ok(start>=0 && end>start)
  const mod={exports:{}}
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=sendReceipt',{
    module:mod,sendNode:async node=>nodes.push(node),unixTimestampSeconds:()=>123,
    logger:{debug(){}},Boom:Error,isPnUser:jid=>jid.endsWith('@s.whatsapp.net'),isLidUser:jid=>jid.endsWith('@lid'),
  })
  s.sendReceipt=mod.exports
  const {encodeBinaryNode,decodeBinaryNode}=require('@whiskeysockets/baileys')
  s.sendNode=async node=>nodes.push(await decodeBinaryNode(encodeBinaryNode(node)))
  require('../lib/safful-mobile-notifications')(s)
  h.engine.attach(s);h.engine.setMode('on')
  const incoming=status('wire');incoming.key.participant='900003:5@lid'
  s.ev.emit('messages.upsert',{messages:[incoming]});await settle()
  assert.equal(nodes.length,2)
  assert.equal(nodes[0].attrs.to,'status@broadcast');assert.equal(nodes[0].attrs.participant,'900003@lid')
  assert.equal(nodes[0].attrs.type,'read')
  assert.equal(nodes[1].attrs.to,'status@broadcast');assert.equal(nodes[1].attrs.participant,'900003@lid')
  assert.equal(nodes[1].attrs.type,'read');assert.equal(nodes[1].attrs.id,'wire')
  assert.equal(nodes[1].attrs.class,'status');assert.equal(nodes[0].attrs.class,undefined)
  await s.sendReceipt('233240000003@s.whatsapp.net',undefined,['dm'],'read')
  assert.equal(nodes.length,2)
})
