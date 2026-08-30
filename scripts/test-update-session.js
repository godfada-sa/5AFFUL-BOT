const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createSessionStore } = require('../lib/safful-update-session')

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-session-test-'))

try {
  const sessionDirectory = path.join(temporaryRoot, 'lib', 'Safful_Session')
  fs.mkdirSync(sessionDirectory, { recursive: true })
  fs.writeFileSync(path.join(sessionDirectory, 'creds.json'), JSON.stringify({ registered: true, me: { id: '123@s.whatsapp.net' } }))
  fs.writeFileSync(path.join(sessionDirectory, 'app-state-sync-key-test.json'), '{"key":"preserved"}')

  const store = createSessionStore(temporaryRoot)
  const backup = store.snapshot('test-update')
  assert.strictEqual(backup.saved, true, 'session snapshot should be created')

  fs.renameSync(sessionDirectory, path.join(temporaryRoot, 'lib', 'lost-session'))
  const recovery = store.restoreLatestIfNeeded()
  assert.strictEqual(recovery.restored, true, 'missing session should be restored')
  assert.strictEqual(store.usableCredentials(sessionDirectory), true, 'restored credentials should be usable')
  assert.strictEqual(
    fs.readFileSync(path.join(sessionDirectory, 'app-state-sync-key-test.json'), 'utf8'),
    '{"key":"preserved"}',
    'all session key files should be preserved',
  )

  const { commands } = require('../lib/plugins')
  require('../plugins/owner-tools')
  const update = commands.find(command => command.pattern === 'update')
  assert(update, 'update command should be registered')
  assert(update.alias.includes('gitpull'), 'gitpull alias should be registered')
  assert(commands.some(command => command.pattern === 'restart'), 'restart command should be registered')

  process.stdout.write('Update-session protection tests passed.\n')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}

process.exit(0)
