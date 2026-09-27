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

function pathsFromGit(result) {
  return String(result.stdout || '').split('\0').filter(Boolean)
}

function safeProjectFile(relative, root = PROJECT_ROOT) {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return null
  const absolute = path.resolve(root, relative)
  const inside = path.relative(root, absolute)
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? absolute : null
}

function moveUntrackedCollisions(root, collisions) {
  if (!collisions.length) return { moved: [], directory: null }
  const directory = path.join(root, '.safful-data', 'update-conflicts', `${Date.now()}-${process.pid}`)
  const moved = []
  try {
    for (const relative of collisions) {
      const source = safeProjectFile(relative, root)
      const destination = path.resolve(directory, relative)
      const inside = path.relative(directory, destination)
      const real = source && fs.existsSync(source) ? fs.realpathSync(source) : null
      const realInside = real && path.relative(root, real)
      if (!source || !inside || inside.startsWith('..') || path.isAbsolute(inside) ||
          !realInside || realInside.startsWith('..') || path.isAbsolute(realInside) ||
          !fs.lstatSync(source).isFile()) {
        throw new Error(`Unsafe untracked collision: ${relative}`)
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(source, destination)
      moved.push({ source, destination, relative })
    }
  } catch (error) {
    for (const item of moved.reverse()) fs.renameSync(item.destination, item.source)
    throw error
  }
  return { moved, directory }
}

async function protectUntrackedCollisions(branch) {
  const incoming = await runProcess('git', ['diff', '--name-only', '--diff-filter=A', '-z', 'HEAD', `origin/${branch}`], 30000)
  const untracked = await runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], 30000)
  if (!incoming.ok || !untracked.ok) throw new Error('Could not inspect incoming files and local untracked files safely')
  const additions = new Set(pathsFromGit(incoming))
  return moveUntrackedCollisions(PROJECT_ROOT, pathsFromGit(untracked).filter(name => additions.has(name)))
}

// Panel deployments are often unpacked or edited in place, leaving tracked
// files modified even though they are not intentional local commits. A normal
// fast-forward pull refuses to overwrite them. Preserve those edits in Git's
// stash, but keep the panel's live .env in place after the update.
async function stashTrackedChangesForUpdate() {
  const status = await runProcess('git', ['status', '--porcelain'], 30000)
  if (!status.ok) throw new Error('Could not inspect local changes before update')
  const tracked = String(status.stdout || '').split(/\r?\n/).filter(line => line && !line.startsWith('??'))
  if (!tracked.length) return { stashed: false, envBackup: null }

  const envPath = path.join(PROJECT_ROOT, '.env')
  let envBackup = null
  if (fs.existsSync(envPath)) {
    envBackup = path.join(PROJECT_ROOT, '.safful-data', 'update-config', `${Date.now()}-${process.pid}.env`)
    fs.mkdirSync(path.dirname(envBackup), { recursive: true })
    fs.copyFileSync(envPath, envBackup)
  }

  const stash = await runProcess('git', ['stash', 'push', '--message', `safful-auto-update-${Date.now()}`], 60000)
  if (!stash.ok) throw new Error(`Could not preserve local changes: ${shortResult(stash)}`)
  return { stashed: true, envBackup }
}

function restorePanelEnv(backup) {
  if (!backup?.envBackup) return
  const envPath = path.join(PROJECT_ROOT, '.env')
  fs.copyFileSync(backup.envBackup, envPath)
}

function restoreUntrackedCollisions(backup) {
  for (const item of backup.moved) {
    if (!fs.existsSync(item.source)) fs.renameSync(item.destination, item.source)
  }
}

async function protectSession(label) {
  const backup = sessionStore.snapshot(label)
  if (!backup.saved) return backup
  try { await sessionGuard.backupSession() } catch {}
  return backup
}

function scheduleControlledRestart(delayMs = 2500) {
  global.__saffulAllowHardExit = true
  // A successful exit is treated as a manual stop by many Node panels. A
  // controlled non-zero exit makes PM2/Pterodactyl restart the service.
  setTimeout(() => process.exit(1), delayMs).unref?.()
}

async function resolveUpdateBranch(currentBranch, run = runProcess) {
  const candidates = [...new Set([process.env.GIT_BRANCH, 'main', currentBranch].filter(Boolean))]
  for (const branch of candidates) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..')) continue
    const result = await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], 30000)
    if (result.ok) return branch
  }
  return null
}

async function initializeCheckout(branch, { root = PROJECT_ROOT, run = runProcess } = {}) {
  // This recovery is only for an unborn repository, never an existing checkout.
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], 30000)
  if (head.ok) throw new Error('Repository already has a commit; use the normal update path')
  const index = await run('git', ['ls-files', '--stage', '-z'], 30000)
  if (!index.ok || pathsFromGit(index).length) throw new Error('Initialization cancelled: the index contains staged files or could not be inspected')
  const tree = await run('git', ['ls-tree', '-r', '--name-only', '-z', `origin/${branch}`], 30000)
  if (!tree.ok) throw new Error('Could not inspect the fetched repository')
  const incoming = pathsFromGit(tree)
  // Repository files must never replace authentication, local configuration, or backups.
  for (const name of incoming) {
    if (!safeProjectFile(name, root) || /^(?:\.git|\.env|\.safful-data|\.safful-secrets|node_modules)(?:\/|$)/i.test(name) ||
        /^lib\/(?:Safful_Session|Suhail_Baileys)(?:\/|$)/i.test(name)) {
      throw new Error(`Initialization cancelled: protected or unsafe incoming path ${name}`)
    }
  }
  const backup = moveUntrackedCollisions(root, incoming.filter(name => fs.existsSync(safeProjectFile(name, root))))
  const checkout = await run('git', ['checkout', '-B', branch, '--track', `origin/${branch}`], 60000)
  if (!checkout.ok) {
    restoreUntrackedCollisions(backup)
    throw new Error(`Checkout failed; conflicting files were preserved: ${shortResult(checkout)}`)
  }
  const verified = await run('git', ['rev-parse', '--verify', 'HEAD'], 30000)
  if (!verified.ok) throw new Error('Checkout did not produce a valid HEAD; do not restart')
  return backup
}

async function runUpdate(message, { restart = true } = {}) {
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
  const branch = await resolveUpdateBranch(String(branchResult.stdout || '').trim())
  if (!branch) return message.reply('Update cancelled: no published update branch was found on origin.')

  const countsResult = await runProcess('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`], 30000)
  if (!countsResult.ok) return message.reply(`❌ Could not compare updates.\n${shortResult(countsResult)}`)
  const [ahead = 0, behind = 0] = String(countsResult.stdout).trim().split(/\s+/).map(Number)
  if (ahead > 0) return message.reply(`❌ Update cancelled: this installation has ${ahead} local commit(s) not on GitHub.`)
  if (!behind) {
    if (!restart) return message.reply('✅ Repository is already up to date. Session preserved.')
    await message.reply('✅ Repository is already up to date. Restarting to load the installed code; session preserved.')
    scheduleControlledRestart()
    return
  }

  const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], 30000)
  if (!head.ok) return message.reply('❌ Git initialization is incomplete (no local HEAD commit). Run `.gitinit` to safely finish setup, then `.update`.')

  await message.reply(`⬇️ Installing ${behind} update commit(s)…`)
  let collisionBackup
  try { collisionBackup = await protectUntrackedCollisions(branch) }
  catch (error) { return message.reply(`❌ Update cancelled before pull: ${error.message}`) }
  let trackedBackup
  try { trackedBackup = await stashTrackedChangesForUpdate() }
  catch (error) {
    restoreUntrackedCollisions(collisionBackup)
    return message.reply(`❌ Update cancelled before pull: ${error.message}`)
  }
  const pullResult = await runProcess('git', ['pull', '--ff-only', 'origin', branch])
  if (!pullResult.ok) {
    restorePanelEnv(trackedBackup)
    restoreUntrackedCollisions(collisionBackup)
    return message.reply(`❌ Git pull failed; the bot was not restarted.\n${shortResult(pullResult)}`)
  }

  try { restorePanelEnv(trackedBackup) }
  catch (error) { return message.reply(`❌ Code updated, but restoring the panel .env failed: ${error.message}`) }

  if (collisionBackup.moved.length) {
    await message.reply(`📦 Preserved ${collisionBackup.moved.length} conflicting untracked file(s) in ${path.relative(PROJECT_ROOT, collisionBackup.directory)}.`)
  }
  if (trackedBackup.stashed) {
    await message.reply('📦 Preserved local tracked changes in Git stash; the panel .env was restored.')
  }

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
  if (restart) {
    await message.reply('✅ Update installed and session preserved. Restarting once to load the new code…')
    scheduleControlledRestart()
  } else {
    await message.reply('✅ Repository pulled and session preserved. Use `.update` to load the new code.')
  }
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
  protectUntrackedCollisions,
  restoreUntrackedCollisions,
  moveUntrackedCollisions,
  stashTrackedChangesForUpdate,
  restorePanelEnv,
  resolveUpdateBranch,
  initializeCheckout,
}
