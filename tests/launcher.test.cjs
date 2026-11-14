'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  buildWorkerEnv,
  cleanupRuntimeCaches,
  deviceCount,
  quarantineDuplicatedSession,
  sessionIdentity,
  shouldCopy,
} = require('../launcher')

test('device count is backward compatible and capped at two', () => {
  assert.equal(deviceCount(undefined), 1)
  assert.equal(deviceCount('2'), 2)
  assert.equal(deviceCount('20'), 2)
  assert.equal(deviceCount('invalid'), 1)
})

test('device 2 receives isolated identity and port settings', () => {
  const env = buildWorkerEnv(2, {
    PORT: '8001',
    OWNER_NUMBER: '111',
    OWNER_NUMBER_2: '222',
    PAIRING_NUMBER_2: '333',
  })

  assert.equal(env.SAFFUL_DEVICE_ID, '2')
  assert.equal(env.PORT, '8002')
  assert.equal(env.OWNER_NUMBER, '222')
  assert.equal(env.PAIRING_NUMBER, '333')
})

test('device runtime copy filter excludes credentials, dependencies and sessions', () => {
  const root = path.join(__dirname, '..')
  assert.equal(shouldCopy(path.join(root, 'index.js')), true)
  assert.equal(shouldCopy(path.join(root, 'lib', 'safful-autoview.json')), false)
  assert.equal(shouldCopy(path.join(root, 'lib', 'safful-protection.json')), false)
  assert.equal(shouldCopy(path.join(root, 'lib', 'safful-status-save.json')), false)
  assert.equal(shouldCopy(path.join(root, 'lib', 'safful-status-save.json.tmp')), false)
  assert.equal(shouldCopy(path.join(root, '.env')), false)
  assert.equal(shouldCopy(path.join(root, 'node_modules')), false)
  assert.equal(shouldCopy(path.join(root, '.npm')), false)
  assert.equal(shouldCopy(path.join(root, '.cache')), false)
  assert.equal(shouldCopy(path.join(root, '.pnpm-store')), false)
  assert.equal(shouldCopy(path.join(root, 'releases')), false)
  assert.equal(shouldCopy(path.join(root, '.safful-secrets')), false)
  assert.equal(shouldCopy(path.join(root, 'lib', 'Safful_Baileys', 'creds.json')), false)
})

test('stale dependency and package caches are removed only inside Device 2 runtime', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-runtime-cache-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const runtimeRoot = path.join(scratch, '.safful-devices')
  const runtime = path.join(runtimeRoot, 'device-2')
  for (const name of ['node_modules', '.npm', '.cache']) {
    fs.mkdirSync(path.join(runtime, name), { recursive: true })
    fs.writeFileSync(path.join(runtime, name, 'large-cache.bin'), 'cache')
  }
  fs.mkdirSync(path.join(runtime, 'Safful_Session'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'Safful_Session', 'creds.json'), '{}')

  assert.deepEqual(cleanupRuntimeCaches(runtime, runtimeRoot).sort(), ['.cache', '.npm', 'node_modules'].sort())
  assert.equal(fs.existsSync(path.join(runtime, 'node_modules')), false)
  assert.equal(fs.existsSync(path.join(runtime, '.npm')), false)
  assert.equal(fs.existsSync(path.join(runtime, '.cache')), false)
  assert.equal(fs.existsSync(path.join(runtime, 'Safful_Session', 'creds.json')), true)
  assert.throws(() => cleanupRuntimeCaches(scratch, runtimeRoot), /outside the isolated device runtime/)
})

test('a copied Device 1 login is quarantined so Device 2 receives a fresh login prompt', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-session-isolation-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const primary = path.join(scratch, 'primary')
  const secondary = path.join(scratch, 'secondary')
  const credentials = { registered: true, account: { details: 'present' }, me: { id: '233500000001:7@s.whatsapp.net' } }
  for (const root of [primary, secondary]) {
    fs.mkdirSync(path.join(root, 'Safful_Session'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Safful_Session', 'creds.json'), JSON.stringify(credentials))
  }

  const backup = quarantineDuplicatedSession(secondary, primary)
  assert.match(backup, /\.safful-quarantine/)
  assert.equal(sessionIdentity(primary).id, '233500000001@s.whatsapp.net')
  assert.equal(sessionIdentity(secondary), null)
  assert.equal(fs.existsSync(path.join(backup, 'creds.json')), true)
})
