'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { createRequire } = require('node:module')
const { deploymentRoot, protectedUpdatePath, acquireUpdateLock } = require('../lib/safful-deployment')
const { createSessionStore, createDeploymentSessionStore } = require('../lib/safful-update-session')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-dual-update-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function session(root, id, legacy = false) {
  const directory = path.join(root, legacy ? 'lib/Suhail_Baileys' : 'Safful_Session')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'creds.json'), JSON.stringify({ registered: true, me: { id } }))
  fs.writeFileSync(path.join(directory, 'test-key.json'), JSON.stringify({ fixture: id }))
  return directory
}

test('both account runtimes resolve to the main deployment; protected paths include both sessions', t => {
  const root = fixture(t)
  assert.equal(deploymentRoot(root), root)
  assert.equal(deploymentRoot(path.join(root, '.safful-devices', 'device-2')), root)
  for (const name of ['Safful_Session/creds.json', 'lib/Suhail_Baileys/pre-key.json',
    '.safful-devices/device-2/plugins/owner-tools.js', '.safful-secrets/session-backups/x', '.env']) {
    assert.equal(protectedUpdatePath(name), true, name)
  }
  assert.equal(protectedUpdatePath('.env.example'), false)
  assert.equal(protectedUpdatePath('lib/safful-session-guard-v2.js'), false)
})

test('E2E: update snapshots both root sessions and restores only the missing account with its own keys', t => {
  const root = fixture(t), second = path.join(root, '.safful-devices', 'device-2')
  const firstSession = session(root, '1001@s.whatsapp.net')
  const secondSession = session(second, '1002@s.whatsapp.net')
  const store = createDeploymentSessionStore(root)
  const backup = store.snapshot('test-update')
  assert.equal(backup.saved, true)
  assert.equal(backup.accounts, 2)
  fs.writeFileSync(path.join(firstSession, 'test-key.json'), 'newer active key')
  fs.unlinkSync(path.join(secondSession, 'creds.json'))
  assert.equal(store.restoreLatestIfNeeded().current, true)
  assert.equal(fs.readFileSync(path.join(firstSession, 'test-key.json'), 'utf8'), 'newer active key')
  assert.equal(JSON.parse(fs.readFileSync(path.join(secondSession, 'creds.json'))).me.id, '1002@s.whatsapp.net')
  assert.equal(JSON.parse(fs.readFileSync(path.join(secondSession, 'test-key.json'))).fixture, '1002@s.whatsapp.net')
})

test('update supports one linked account with device 2 left unpaired, and legacy session locations', t => {
  const root = fixture(t)
  const legacy = session(root, '1001@s.whatsapp.net', true)
  assert.equal(createSessionStore(root).currentSessionDirectory(), legacy)
  const store = createDeploymentSessionStore(root)
  assert.equal(store.snapshot().accounts, 1)
  assert.equal(store.restoreLatestIfNeeded().current, true)
  assert.equal(fs.existsSync(path.join(root, '.safful-devices')), false)
})

test('updates from two accounts cannot hold the deployment lock simultaneously', t => {
  const root = fixture(t)
  const release = acquireUpdateLock(root)
  assert.throws(() => acquireUpdateLock(root), /already running/)
  release()
  acquireUpdateLock(root)()
})

function updateHarness(t, { behind = 1, protectedTree = false, ipc = true, npmFails = false } = {}) {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, '.git'))
  const calls = [], replies = [], requests = [], timers = []
  const filename = path.resolve(__dirname, '../plugins/owner-tools.js')
  const native = createRequire(filename), module = { exports: {} }
  const env = { SAFFUL_DEVICE_ID: '2' }
  const state = { saved: 0, validated: 0 }
  function spawn(command, args, options) {
    calls.push({ command, args, cwd: options.cwd })
    const child = new EventEmitter()
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      let output = ''
      if (args[0] === 'branch') output = 'main'
      if (args[0] === 'rev-list') output = '0\t' + behind
      if (args[0] === 'ls-tree') output = protectedTree ? '.safful-devices/device-2/Safful_Session/creds.json\0' : 'plugins/new.js\0'
      child.stdout.emit('data', output)
      child.emit('close', npmFails && command.startsWith('npm') ? 1 : 0)
    })
    return child
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename,
    __dirname: path.join(root, '.safful-devices', 'device-2', 'plugins'),
    process: { env, platform: process.platform, connected: ipc,
      send: ipc ? request => requests.push(request) : undefined, exit: () => { throw Error('must not exit only device 2') } },
    global: {}, console,
    setTimeout: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer },
    clearTimeout: timer => { timer.cleared = true },
    require: name => {
      if (name === 'child_process') return { spawn }
      if (name === '../lib/plugins') return { cmd() {} }
      if (name === '../lib/safful-mode') return { isOwner: () => true }
      if (name === '../lib/safful-session-guard-v2') return { backupSession: async () => {} }
      if (name === '../lib/safful-update-session') return {
        snapshot: () => { state.saved++; return { saved: true, accounts: 2 } },
        restoreLatestIfNeeded: () => { state.validated++; return { current: true } },
      }
      return native(name)
    },
  }, { filename })
  return { root, calls, replies, requests, timers, state, api: module.exports,
    message: { reply: async text => replies.push(text) } }
}

test('E2E: device 2 updates only the main checkout and requests a deployment restart after validation/install', async t => {
  const h = updateHarness(t)
  await h.api.runUpdate(h.message)
  assert.ok(h.calls.length > 5)
  assert.ok(h.calls.every(call => call.cwd === h.root))
  assert.equal(h.state.saved, 1)
  assert.equal(h.state.validated, 1)
  assert.ok(h.calls.some(call => call.command.startsWith('npm')))
  h.timers.filter(timer => !timer.cleared).forEach(timer => timer.fn())
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].type, 'safful:restart-deployment')
})

test('update after gitinit installs dependencies even when HEAD is already current', async t => {
  const h = updateHarness(t, { behind: 0 })
  await h.api.runUpdate(h.message)
  assert.ok(h.calls.some(call => call.command.startsWith('npm')))
  assert.equal(h.state.validated, 1)
})

test('protected incoming paths and failed dependency installs cancel restart', async t => {
  for (const options of [{ protectedTree: true }, { npmFails: true }]) {
    const h = updateHarness(t, options)
    await h.api.runUpdate(h.message)
    assert.equal(h.timers.filter(timer => !timer.cleared).length, 0)
    assert.equal(h.requests.length, 0)
    if (options.protectedTree) assert.ok(!h.calls.some(call => call.args[0] === 'pull'))
  }
})

test('workers on an older launcher request a panel restart rather than restarting just one account', async t => {
  const h = updateHarness(t, { behind: 0, ipc: false })
  await h.api.runUpdate(h.message)
  assert.match(h.replies.at(-1), /Restart the panel once/)
  assert.equal(h.timers.filter(timer => !timer.cleared).length, 0)
})
