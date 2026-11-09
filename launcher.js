'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const PROJECT_ROOT = __dirname
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.safful-devices')
const MAX_DEVICES = 2
const DEVICE_OVERRIDES = [
  'OWNER_NUMBER',
  'SUDO',
  'OWNER_NAME',
  'BOT_NAME',
  'AUTH_METHOD',
  'PAIRING_NUMBER',
  'PORT',
  'MONGODB_URI',
  'DATABASE_URL',
]

const ROOT_EXCLUDES = new Set([
  '.cache',
  '.git',
  '.env',
  '.npm',
  '.pnpm-store',
  '.safful-data',
  '.safful-devices',
  '.safful-quarantine',
  '.yarn',
  'node_modules',
  'releases',
])
const RUNTIME_CACHE_NAMES = ['.cache', '.npm', '.pnpm-store', '.yarn', 'node_modules']
const SESSION_NAMES = /^(?:Safful_Baileys|Suhail_Baileys|Safful_Session)$/i

function normalizeAccountId(value) {
  return String(value || '').trim().replace(/:\d+@/, '@')
}

function sessionIdentity(runtime) {
  for (const name of ['Safful_Session', 'Safful_Baileys', 'Suhail_Baileys']) {
    try {
      const credentials = JSON.parse(fs.readFileSync(path.join(runtime, name, 'creds.json'), 'utf8'))
      const id = normalizeAccountId(credentials?.me?.id)
      if (credentials?.registered && credentials?.account && id) return { id, directory: name }
    } catch {}
  }
  return null
}

function quarantineDuplicatedSession(runtime, projectRoot = PROJECT_ROOT) {
  const primary = sessionIdentity(projectRoot)
  const secondary = sessionIdentity(runtime)
  if (!primary || !secondary || primary.id !== secondary.id) return ''

  const quarantineRoot = path.join(runtime, '.safful-quarantine')
  fs.mkdirSync(quarantineRoot, { recursive: true })
  const source = path.join(runtime, secondary.directory)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = path.join(quarantineRoot, `duplicate-device-1-session-${stamp}`)
  fs.renameSync(source, destination)
  return destination
}

function deviceCount(value = process.env.DEVICE_COUNT) {
  const parsed = Number.parseInt(String(value || '1'), 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_DEVICES, parsed)) : 1
}

function buildWorkerEnv(device, baseEnv = process.env) {
  const env = { ...baseEnv, SAFFUL_DEVICE_ID: String(device) }
  for (const key of DEVICE_OVERRIDES) {
    const override = baseEnv[`${key}_${device}`]
    if (override !== undefined && String(override).trim() !== '') env[key] = override
  }

  if (device > 1 && !baseEnv[`PORT_${device}`]) {
    const basePort = Number.parseInt(String(baseEnv.PORT || '8001'), 10)
    env.PORT = String((Number.isFinite(basePort) ? basePort : 8001) + device - 1)
  }
  return env
}

function shouldCopy(source) {
  const relative = path.relative(PROJECT_ROOT, source)
  if (!relative || relative.startsWith('..')) return true
  const parts = relative.split(path.sep)
  if (ROOT_EXCLUDES.has(parts[0])) return false
  // Keep each account's persisted autoview and anti-delete choices on restart.
  if (parts[0] === 'lib' && /^safful-(?:autoview|protection)\.json(?:\.tmp)?$/.test(parts[1])) return false
  if (parts.some((part) => SESSION_NAMES.test(part))) return false
  if (/\.zip$/i.test(parts.at(-1))) return false
  return true
}

function cleanupRuntimeCaches(runtime, runtimeRoot = RUNTIME_ROOT) {
  const resolvedRuntime = path.resolve(runtime)
  const resolvedRoot = path.resolve(runtimeRoot)
  if (resolvedRuntime === resolvedRoot || !resolvedRuntime.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Refusing to clean caches outside the isolated device runtime')
  }

  const removed = []
  for (const name of RUNTIME_CACHE_NAMES) {
    const target = path.join(resolvedRuntime, name)
    if (!fs.existsSync(target)) continue
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 })
    removed.push(name)
  }
  return removed
}

function prepareRuntime(device) {
  if (device === 1) return PROJECT_ROOT
  const runtime = path.join(RUNTIME_ROOT, `device-${device}`)
  fs.mkdirSync(runtime, { recursive: true })
  const removedCaches = cleanupRuntimeCaches(runtime)
  if (removedCaches.length) {
    process.stdout.write(`[launcher] device ${device}: removed duplicated runtime caches: ${removedCaches.join(', ')}\n`)
  }

  for (const name of fs.readdirSync(PROJECT_ROOT)) {
    const source = path.join(PROJECT_ROOT, name)
    if (!shouldCopy(source)) continue
    fs.cpSync(source, path.join(runtime, name), {
      recursive: true,
      force: true,
      filter: shouldCopy,
    })
  }
  return runtime
}

function launch(options = {}) {
  try {
    require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') })
  } catch {}

  const count = deviceCount(options.deviceCount)
  const workerEntry = String(options.workerEntry || process.env.SAFFUL_WORKER_ENTRY || 'index.js')
  if (path.isAbsolute(workerEntry) || workerEntry.split(/[\\/]/).includes('..')) {
    throw new Error('SAFFUL_WORKER_ENTRY must be a safe path inside the deployment')
  }
  const oneShot = options.oneShot ?? process.env.SAFFUL_LAUNCHER_ONESHOT === 'true'
  const children = new Map()
  let stopping = false

  const startDevice = (device) => {
    const runtime = prepareRuntime(device)
    const env = buildWorkerEnv(device)
    const port = env.PORT || 'auto'
    const auth = String(env.AUTH_METHOD || 'qr').trim().toLowerCase()
    if (device > 1) {
      const quarantined = quarantineDuplicatedSession(runtime)
      if (quarantined) {
        process.stdout.write(`[launcher] device ${device}: removed a duplicated Device 1 login from active use; backup=${quarantined}\n`)
      }
    }
    const session = sessionIdentity(runtime) ? 'linked' : 'login-required'
    process.stdout.write(`[launcher] device ${device}/${count}: runtime=${runtime} port=${port} auth=${auth} session=${session}\n`)

    const entry = path.join(runtime, workerEntry)
    if (!fs.existsSync(entry)) throw new Error(`Worker entry not found: ${workerEntry}`)
    const child = spawn(process.execPath, ['--expose-gc', entry], {
      cwd: runtime,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    children.set(device, child)

    child.on('exit', (code, signal) => {
      children.delete(device)
      if (stopping) return
      if (oneShot) {
        if (code !== 0) process.exitCode = 1
        return
      }
      process.stderr.write(`[launcher] device ${device} stopped (${signal || code}); restarting in 5 seconds\n`)
      setTimeout(() => { if (!stopping) startDevice(device) }, 5000)
    })
  }

  for (let device = 1; device <= count; device += 1) startDevice(device)

  const stop = (signal) => {
    if (stopping) return
    stopping = true
    for (const child of children.values()) child.kill(signal)
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
  return children
}

if (require.main === module) launch()

module.exports = {
  MAX_DEVICES,
  buildWorkerEnv,
  cleanupRuntimeCaches,
  deviceCount,
  launch,
  prepareRuntime,
  quarantineDuplicatedSession,
  sessionIdentity,
  shouldCopy,
}
