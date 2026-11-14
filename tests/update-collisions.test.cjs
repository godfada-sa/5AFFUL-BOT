'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const filename = path.resolve(__dirname, '..', 'plugins', 'owner-tools.js')
const moduleStub = { exports: {} }
const native = createRequire(filename)
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: moduleStub, exports: moduleStub.exports, __dirname: path.dirname(filename), __filename: filename,
  process, global, console, setTimeout, clearTimeout,
  require: key => {
    if (key === '../lib/plugins') return { cmd() {} }
    if (key === '../lib/safful-mode') return { isOwner: () => true }
    if (key === '../lib/safful-session-guard') return { backupSession: async () => {} }
    if (key === '../lib/safful-update-session') return { snapshot: () => ({ saved: true }), restoreLatestIfNeeded: () => ({ current: true }) }
    return native(key)
  },
}, { filename })
const { moveUntrackedCollisions, restoreUntrackedCollisions, resolveUpdateBranch, initializeCheckout } = moduleStub.exports
const { spawnSync } = require('child_process')

function unbornFixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-gitinit-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const upstream = path.join(temp, 'upstream'), root = path.join(temp, 'zip-install')
  fs.mkdirSync(upstream); fs.mkdirSync(root)
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
    return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '' }
  }
  const must = (cwd, args) => { const result = git(cwd, args); assert.equal(result.ok, true, result.stderr); return result }
  must(upstream, ['init', '-b', 'main'])
  fs.writeFileSync(path.join(upstream, 'README.md'), 'new readme')
  fs.mkdirSync(path.join(upstream, 'plugins'))
  fs.writeFileSync(path.join(upstream, 'plugins', 'bot.js'), 'new code')
  fs.writeFileSync(path.join(upstream, '.gitignore'), 'ignored.txt\n.env\nlib/Safful_Session/\n')
  fs.writeFileSync(path.join(upstream, 'ignored.txt'), 'upstream ignored file')
  must(upstream, ['add', '-f', '.'])
  must(upstream, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture'])
  fs.writeFileSync(path.join(root, 'README.md'), 'custom local readme')
  fs.mkdirSync(path.join(root, 'plugins'))
  fs.writeFileSync(path.join(root, 'plugins', 'bot.js'), 'old code')
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n.env\nlib/Safful_Session/\n')
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'local ignored file')
  fs.writeFileSync(path.join(root, '.env'), 'local secret')
  fs.mkdirSync(path.join(root, 'lib', 'Safful_Session'), { recursive: true })
  fs.writeFileSync(path.join(root, 'lib', 'Safful_Session', 'creds.json'), '{"registered":true}')
  const secondSession = path.join(root, '.safful-devices', 'device-2', 'Safful_Session')
  fs.mkdirSync(secondSession, { recursive: true })
  fs.writeFileSync(path.join(secondSession, 'creds.json'), '{"registered":true,"me":{"id":"1002@s.whatsapp.net"}}')
  must(root, ['init'])
  must(root, ['remote', 'add', 'origin', upstream])
  must(root, ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  return { root, git, must, run: async (_command, args) => git(root, args) }
}

test('ZIP and failed-init recovery backs up conflicts including ignored files and establishes HEAD without touching session', async t => {
  const h = unbornFixture(t)
  const before = h.git(h.root, ['checkout', '-b', 'main', '--track', 'origin/main'])
  assert.equal(before.ok, false)
  const backup = await initializeCheckout('main', h)
  assert.equal(backup.moved.length, 4)
  assert.equal(fs.readFileSync(path.join(h.root, 'README.md'), 'utf8'), 'new readme')
  assert.equal(fs.readFileSync(path.join(backup.directory, 'README.md'), 'utf8'), 'custom local readme')
  assert.equal(fs.readFileSync(path.join(backup.directory, 'ignored.txt'), 'utf8'), 'local ignored file')
  assert.equal(fs.readFileSync(path.join(h.root, '.env'), 'utf8'), 'local secret')
  assert.equal(fs.readFileSync(path.join(h.root, 'lib/Safful_Session/creds.json'), 'utf8'), '{"registered":true}')
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root, '.safful-devices/device-2/Safful_Session/creds.json'))).me.id, '1002@s.whatsapp.net')
  h.must(h.root, ['rev-parse', '--verify', 'HEAD'])
  h.must(h.root, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])
  await assert.rejects(initializeCheckout('main', h), /already has a commit/)
})

test('failed bootstrap checkout restores displaced files', async t => {
  const h = unbornFixture(t)
  const run = async (command, args) => args[0] === 'checkout'
    ? { ok: false, stderr: 'simulated checkout failure' } : h.run(command, args)
  await assert.rejects(initializeCheckout('main', { root: h.root, run }), /Checkout failed/)
  assert.equal(fs.readFileSync(path.join(h.root, 'README.md'), 'utf8'), 'custom local readme')
  assert.equal(fs.readFileSync(path.join(h.root, 'ignored.txt'), 'utf8'), 'local ignored file')
})

test('bootstrap refuses staged files and protected paths before moving anything', async t => {
  const h = unbornFixture(t)
  h.must(h.root, ['add', 'README.md'])
  await assert.rejects(initializeCheckout('main', h), /staged files/)
  const run = async (_command, args) => {
    if (args[0] === 'rev-parse') return { ok: false }
    if (args[0] === 'ls-files') return { ok: true, stdout: '' }
    return { ok: true, stdout: 'README.md\0lib/Safful_Session/creds.json\0' }
  }
  await assert.rejects(initializeCheckout('main', { root: h.root, run }), /protected or unsafe/)
  assert.equal(fs.readFileSync(path.join(h.root, 'README.md'), 'utf8'), 'custom local readme')
})

test('master checkouts select published main when origin/master does not exist', async () => {
  const calls = []
  const branch = await resolveUpdateBranch('master', async (_command, args) => {
    calls.push(args.at(-1))
    return { ok: args.at(-1) === 'refs/remotes/origin/main' }
  })
  assert.equal(branch, 'main')
  assert.equal(calls.includes('refs/remotes/origin/master'), false)
})

test('update preserves only the exact colliding untracked file and can restore on pull failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tests = path.join(root, 'tests')
  fs.mkdirSync(tests)
  const collision = path.join(tests, 'save.test.cjs')
  const unrelated = path.join(tests, 'keep.test.cjs')
  fs.writeFileSync(collision, 'local custom test')
  fs.writeFileSync(unrelated, 'keep me')
  const backup = moveUntrackedCollisions(root, ['tests/save.test.cjs'])
  assert.equal(backup.moved.length, 1)
  assert.equal(fs.existsSync(collision), false)
  assert.equal(fs.readFileSync(backup.moved[0].destination, 'utf8'), 'local custom test')
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me')
  restoreUntrackedCollisions(backup)
  assert.equal(fs.readFileSync(collision, 'utf8'), 'local custom test')
})

test('update refuses traversal paths without moving other files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => moveUntrackedCollisions(root, ['../outside.txt']), /Unsafe untracked collision/)
})
