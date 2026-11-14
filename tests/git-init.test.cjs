'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), path = require('path'), vm = require('vm')

function load({ head = false, saved = true, remote = 'https://github.com/godfada-sa/5AFFUL-BOT.git' } = {}) {
  const state = { snapshots: 0, checkouts: 0, updates: 0, calls: [], replies: [] }
  const filename = path.resolve(__dirname, '../plugins/git-init.js'), mod = { exports: {} }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, __filename: filename, process: { env: {} }, require: name => {
      if (name === 'fs') return { existsSync: () => true }
      if (name === '../lib/plugins') return { cmd() {} }
      if (name === '../lib/safful-mode') return { isOwner: () => true }
      if (name === '../lib/safful-update-session') return { restoreLatestIfNeeded: () => ({ current: true }) }
      if (name === './owner-tools') return {
        PROJECT_ROOT: '/fixture', shortResult: () => 'failure',
        withUpdateLock: async (_message, action) => action(),
        runUpdate: async () => state.updates++,
        protectSession: async () => { state.snapshots++; return { saved, reason: 'No session' } },
        resolveUpdateBranch: async () => 'main',
        initializeCheckout: async () => { state.checkouts++; return { moved: [], directory: null } },
        runProcess: async (_command, args) => {
          state.calls.push(args)
          if (args[0] === 'rev-parse') return { ok: head }
          if (args[0] === 'remote') return { ok: true, stdout: remote }
          return { ok: true }
        },
      }
      return require(name)
    },
  })
  return { state, plugin: mod.exports, message: { reply: async text => state.replies.push(text) } }
}

test('gitinit recovers existing .git without HEAD, explicitly fetches main, and snapshots session first', async () => {
  const h = load()
  await h.plugin.gitInit(h.message)
  assert.equal(h.state.updates, 0)
  assert.equal(h.state.snapshots, 1)
  assert.equal(h.state.checkouts, 1)
  assert.ok(h.state.calls.some(args => args.includes('+refs/heads/main:refs/remotes/origin/main')))
  assert.match(h.state.replies.at(-1), /Use `.update`/)
})

test('gitinit uses normal update for valid HEAD and refuses missing session or mismatched remote', async () => {
  const existing = load({ head: true })
  await existing.plugin.gitInit(existing.message)
  assert.equal(existing.state.updates, 1)
  assert.equal(existing.state.checkouts, 0)
  for (const options of [{ saved: false }, { remote: 'https://example.com/other.git' }]) {
    const h = load(options)
    await h.plugin.gitInit(h.message)
    assert.equal(h.state.checkouts, 0)
    assert.match(h.state.replies.at(-1), /cancelled/)
  }
})
