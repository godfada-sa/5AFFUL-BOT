'use strict'

const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')
const { isOwner } = require('../lib/safful-mode')
const { PROJECT_ROOT, runProcess, runUpdate, shortResult, protectSession,
  initializeCheckout, resolveUpdateBranch, withUpdateLock } = require('./owner-tools')
const sessionStore = require('../lib/safful-update-session')

const REPO_URL = String(process.env.GIT_REPO_URL || 'https://github.com/godfada-sa/5AFFUL-BOT.git').trim()

async function gitInit(message) {
  if (!isOwner(message)) return message.reply('❌ Owner only.')
  return withUpdateLock(message, () => gitInitLocked(message))
}

async function gitInitLocked(message) {
  const exists = fs.existsSync(path.join(PROJECT_ROOT, '.git'))
  if (exists) {
    const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], 30000)
    if (head.ok) return runUpdate(message, { restart: false, locked: true })
  }
  const version = await runProcess('git', ['--version'], 30000)
  if (!version.ok) return message.reply(`❌ Git is unavailable: ${shortResult(version)}`)
  await message.reply('🔐 Saving all linked WhatsApp sessions before repository setup…')
  const session = await protectSession('gitinit')
  if (!session.saved) return message.reply(`❌ Initialization cancelled: ${session.reason}`)
  if (!exists) {
    const init = await runProcess('git', ['init'], 30000)
    if (!init.ok) return message.reply(`❌ Git initialization failed: ${shortResult(init)}`)
  }
  const currentRemote = await runProcess('git', ['remote', 'get-url', 'origin'], 30000)
  if (!currentRemote.ok) {
    const remote = await runProcess('git', ['remote', 'add', 'origin', REPO_URL], 30000)
    if (!remote.ok) return message.reply(`❌ Could not configure origin: ${shortResult(remote)}`)
  } else if (currentRemote.stdout.trim().replace(/\.git$/, '').replace(/\/$/, '') !== REPO_URL.replace(/\.git$/, '').replace(/\/$/, '')) {
    return message.reply('❌ Initialization cancelled: origin points to a different repository. Existing remote was not changed.')
  }
  const fetch = await runProcess('git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 4 * 60 * 1000)
  if (!fetch.ok) return message.reply(`❌ Git fetch failed: ${shortResult(fetch)}`)
  try {
    const branch = await resolveUpdateBranch('main')
    if (!branch) return message.reply('❌ No published branch was found; initialization cancelled.')
    const backup = await initializeCheckout(branch)
    if (!sessionStore.restoreLatestIfNeeded().current) return message.reply('❌ Session validation failed after checkout. Do not restart; your session backup is preserved.')
    if (backup.moved.length) await message.reply(`📦 Preserved ${backup.moved.length} conflicting file(s) in ${path.relative(PROJECT_ROOT, backup.directory)}.`)
  } catch (error) {
    return message.reply(`❌ Repository setup stopped safely: ${error.message}`)
  }
  return message.reply('✅ Main repository initialized and pulled. Linked sessions preserved. Use `.update` to install dependencies and restart all accounts.')
}

cmd({ pattern: 'gitinit', alias: ['gitsetup', 'gitfix'], desc: 'Fetch GitHub repository without restarting or deleting session', category: 'owner', filename: __filename }, gitInit)
module.exports = { REPO_URL, gitInit }
