const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { cmd } = require('../lib/plugins')
const { isOwner } = require('../lib/safful-mode')
const sessionGuard = require('../lib/safful-session-guard')
const sessionStore = require('../lib/safful-update-session')

const PROJECT_ROOT = path.resolve(__dirname, '..')

function runProcess(command, args, timeoutMs = 180000) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, ...result })
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, exitCode: null, message: `${command} timed out` })
    }, timeoutMs)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => finish({ ok: false, exitCode: null, message: error.message }))
    child.on('close', exitCode => finish({ ok: exitCode === 0, exitCode, message: '' }))
  })
}

function shortResult(result, maxLength = 500) {
  return String(result?.stderr || result?.stdout || result?.message || 'Unknown error').trim().slice(0, maxLength)
}

async function protectSession(label) {
  const backup = sessionStore.snapshot(label)
  if (!backup.saved) return backup
  try { await sessionGuard.backupSession() } catch {}
  return backup
}

function scheduleControlledRestart(delayMs = 2500) {
  global.__saffulAllowHardExit = true
  setTimeout(() => process.exit(0), delayMs).unref?.()
}

async function runUpdate(message) {
  if (!fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    return message.reply('❌ Update unavailable: this installation has no `.git` folder. Install from the GitHub repository first.')
  }

  await message.reply('🔐 Saving the current WhatsApp session…')
  const backup = await protectSession('gitpull')
  if (!backup.saved) {
    return message.reply(`❌ Update cancelled. ${backup.reason} This prevents an unexpected repair request.`)
  }

  const fetchResult = await runProcess('git', ['fetch', '--prune', 'origin'])
  if (!fetchResult.ok) return message.reply(`❌ Git fetch failed.\n${shortResult(fetchResult)}`)

  const branchResult = await runProcess('git', ['branch', '--show-current'], 30000)
  const branch = String(branchResult.stdout || '').trim()
  if (!branch) return message.reply('❌ Update cancelled: the repository is in detached-HEAD mode.')

  const countsResult = await runProcess('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], 30000)
  if (!countsResult.ok) return message.reply(`❌ Could not compare updates.\n${shortResult(countsResult)}`)
  const [ahead = 0, behind = 0] = String(countsResult.stdout).trim().split(/\s+/).map(Number)
  if (ahead > 0) return message.reply(`❌ Update cancelled: this installation has ${ahead} local commit(s) not on GitHub.`)
  if (!behind) return message.reply('✅ The bot is already up to date. Your session backup is safe.')

  await message.reply(`⬇️ Installing ${behind} update commit(s)…`)
  const pullResult = await runProcess('git', ['pull', '--ff-only', 'origin', branch])
  if (!pullResult.ok) return message.reply(`❌ Git pull failed; the bot was not restarted.\n${shortResult(pullResult)}`)

  const restored = sessionStore.restoreLatestIfNeeded()
  if (!restored.current) {
    return message.reply('❌ Code updated, but session recovery validation failed. Restart cancelled to avoid requesting repair.')
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installResult = await runProcess(npmCommand, ['install', '--omit=dev', '--no-audit', '--no-fund'], 8 * 60 * 1000)
  if (!installResult.ok) {
    return message.reply(`❌ Code updated and session preserved, but dependency installation failed.\n${shortResult(installResult)}`)
  }

  try { await sessionGuard.backupSession() } catch {}
  await message.reply('✅ Update installed and session preserved. Restarting once to load the new code…')
  scheduleControlledRestart()
}

cmd({
  pattern: 'update',
  alias: ['pull', 'upd', 'gitpull', 'upgrade'],
  desc: 'Safely update from GitHub while preserving the WhatsApp session',
  category: 'owner',
  filename: __filename,
}, async message => {
  if (!isOwner(message)) return message.reply('❌ Owner only.')
  return runUpdate(message)
})

cmd({
  pattern: 'restart',
  alias: ['reboot', 'res', 'resume'],
  desc: 'Restart the bot while preserving the WhatsApp session',
  category: 'owner',
  filename: __filename,
}, async message => {
  if (!isOwner(message)) return message.reply('❌ Owner only.')
  const backup = await protectSession('manual-restart')
  if (!backup.saved) return message.reply(`❌ Restart cancelled. ${backup.reason}`)
  await message.reply('🔄 Session saved. Restarting…')
  scheduleControlledRestart(1500)
})

cmd({
  pattern: 'shutdown',
  alias: ['kill', 'off', 'stop'],
  desc: 'Stop the bot completely',
  category: 'owner',
  use: 'sure',
  filename: __filename,
}, async (message, text) => {
  if (!isOwner(message)) return message.reply('❌ Owner only.')
  if (!['sure', 'yes', 'confirm'].includes(String(text || '').trim().toLowerCase())) {
    return message.reply('Use `.shutdown sure` to confirm.')
  }
  await protectSession('shutdown')
  await message.reply('🛑 Session saved. Shutting down…')
  global.__saffulAllowHardExit = true
  setTimeout(() => process.exit(0), 1500).unref?.()
})

module.exports = {
  PROJECT_ROOT,
  protectSession,
  runProcess,
  runUpdate,
  scheduleControlledRestart,
  shortResult,
}
