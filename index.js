// ---------------------------------------------------------------------------
// Node engine guard.
// ---------------------------------------------------------------------------
function saffulCheckNodeVersion() {
  const [major, minor] = String(process.versions.node || '').split('.').map(Number)
  const supported = major >= 23 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19)
  if (supported) return
  process.stdout.write(
    '\n============================================================\n' +
    '  SAFFUL-MD: unsupported Node.js version (' + process.versions.node + ')\n' +
    '  This bot needs Node.js 22.12+ (or 20.19+/23+) because its Baileys\n' +
    '  core is ESM-only and must be loaded with require(esm). Node 21 and\n' +
    '  older 20.x cannot run it (ERR_REQUIRE_ESM).\n' +
    '  Fix: in your hosting panel change the Node image to 22+ and restart.\n' +
    '  Pterodactyl image: ghcr.io/parkervcp/yolks:nodejs_22\n' +
    '============================================================\n'
  )
  process.exit(1)
}
saffulCheckNodeVersion()

// ── Uptime Guardian ──────────────────────────────────────────────────────
// Override process.exit BEFORE any require() so all modules get it.
// Suppress unrequested non-zero exits so transient WhatsApp failures recover
// inside this process instead of making the panel reboot the whole app.
// ──────────────────────────────────────────────────────────────────────────
const __uptime = {
  active: false,
  reconnectCount: 0,
  suppressUntil: 0,
  origExit: process.exit.bind(process),
}
process.exit = function (code) {
  if (code !== 0 && !global.__saffulAllowHardExit) {
    process.stdout.write('[uptime] Suppressing process.exit(' + code + ') — connection supervisor will recover.\n')
    try { global.__saffulRequestReconnect?.('core requested exit(' + code + ')') } catch {}
    return
  }
  return __uptime.origExit(code)
}
global.__saffulUptimeSuppress = function (ms) {
  if (!__uptime.active) {
    __uptime.active = true
    process.stdout.write('[uptime] Guardian activated — will suppress reconnectable disconnects\n')
  }
  __uptime.reconnectCount += 1
  __uptime.suppressUntil = Date.now() + ms
}
global.__saffulUptimeReconnected = function () {
  if (__uptime.reconnectCount > 0) {
    process.stdout.write('[uptime] Reconnected after ' + __uptime.reconnectCount + ' suppressed disconnect(s) — uptime preserved\n')
    __uptime.reconnectCount = 0
  }
}

const fs = require('fs')
const path = require('path')

// ── Temp File Cleanup ────────────────────────────────────────────────────
try {
  const tempDir = path.join(__dirname, 'temp')
  if (fs.existsSync(tempDir)) {
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const name of fs.readdirSync(tempDir)) {
      if (name === '.gitkeep' || name === '.gitignore') continue
      try {
        const fp = path.join(tempDir, name)
        const stat = fs.statSync(fp)
        if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(fp)
      } catch {}
    }
  }
} catch {}

// No stdout.write override — let Pterodactyl/PM2 read the pipe naturally.

if (process.env.SAFFUL_ENABLE_SESSION_ID !== 'true') process.env.SAFFUL_DISABLE_SESSION_ID = 'true'
require(__dirname + '/patch-baileys-version.js')
require(__dirname + '/lib/safful-optional-sharp')
require(__dirname + '/lib/brand-console')
require(__dirname + '/lib/safful-history-mode')
require(__dirname + '/lib/safful-responsive-qr').installResponsiveQrPage()
const updateSession = require(__dirname + '/lib/safful-update-session')
try {
  const recovery = updateSession.restoreLatestIfNeeded()
  if (recovery.restored) process.stdout.write('[session] Restored the latest protected update-session backup.\n')
} catch (error) {
  process.stdout.write(`[session] Update-session recovery failed: ${error?.message || error}\n`)
}
require(__dirname + '/lib/safful-rename-session')
require(__dirname + '/lib/safful-fork-bypass')
const sessionGuard = require(__dirname + '/lib/safful-session-guard')
const { installOutgoingMessagePolicy, rebrandSocket } = require(__dirname + '/lib/safful-outgoing-message-policy')
installOutgoingMessagePolicy()
const preserveMobileNotifications = require(__dirname + '/lib/safful-mobile-notifications')
preserveMobileNotifications.installMobileNotificationGuard()

function suppressSensitiveSignalSessionLogs() {
  const suppressible = /^(Closing session:|Removing old closed session:)/
  const installFilter = (method) => {
    const original = console[method].bind(console)
    console[method] = (...values) => {
      const label = typeof values[0] === 'string' ? values[0] : ''
      if (suppressible.test(label)) {
        console.log('[security] Suppressed sensitive Signal-session debug output.')
        return
      }
      original(...values)
    }
  }
  installFilter('log')
  installFilter('info')
}
suppressSensitiveSignalSessionLogs()

// ── Global Error Handlers ────────────────────────────────────────────────
let __saffulCrashCount = 0
const __saffulCrashWindow = 10 * 60 * 1000
let __saffulCrashWindowStart = Date.now()
process.on('uncaughtException', (error) => {
  const now = Date.now()
  if (now - __saffulCrashWindowStart > __saffulCrashWindow) {
    __saffulCrashCount = 0
    __saffulCrashWindowStart = now
  }
  __saffulCrashCount += 1
  process.stdout.write(`[uptime] UNCAUGHT EXCEPTION (crash #${__saffulCrashCount}): ${error?.stack || error}\n`)
  if (__saffulCrashCount >= 5) {
    process.stdout.write('[uptime] Repeated errors detected — keeping the process alive and recycling the WhatsApp connection.\n')
    __saffulCrashCount = 0
    try { global.__saffulRequestReconnect?.('repeated runtime errors') } catch {}
  }
})
process.on('unhandledRejection', (reason) => {
  process.stdout.write(`[uptime] UNHANDLED REJECTION (suppressed): ${reason?.stack || reason}\n`)
})

const { prepareAuthentication } = require(__dirname + '/lib/safful-auth-method')
const { installAuthRecovery, clearRecoveryState } = require(__dirname + '/lib/safful-auth-recovery')
installAuthRecovery()

const Config = require(__dirname + '/config')
const { VERSION } = Config
const attachProtection = require(__dirname + '/lib/safful-protection')
attachProtection.installEarlyCaptureHook()
process.stdout.write('[anti-delete] pre-core capture hook armed\n')
const autoView = require(__dirname + '/plugins/statusauto.smd')
const statusSave = require(__dirname + '/lib/safful-status-save')
const attachRawDispatcher = require(__dirname + '/lib/safful-raw-dispatcher')

let connectedBannerSent = false
function connectedBannerText() {
  const handlers = Config.HANDLERS
  const prefa = !handlers || ['false', 'null', ' ', '', 'empty'].includes(String(handlers))
  const prefix = prefa ? '' : String(handlers)[0] || ''
  const pluginCount = Array.isArray(require(__dirname + '/lib/plugins').commands)
    ? require(__dirname + '/lib/plugins').commands.length
    : 0
  const mode = String(global.WORKTYPE || Config.WORKTYPE || 'private')
  const dbUrl = String(global.DATABASE_URL || '')
  let database = 'JSON(no db)'
  if (/^mongodb/i.test(dbUrl)) database = 'MongoDB'
  else if (/^postgres/i.test(dbUrl)) database = 'PostgreSQL'
  return [
    '*🤖 SAFFUL-MD BOT CONNECTED*',
    `🔧 *Prefix:* ${prefix || 'none'}  •  📦 *Plugins:* ${pluginCount}`,
    `⚙️ *Mode:* ${mode}  •  🗄️ *Database:* ${database}`,
  ].join('\n')
}

function sudoRecipient() {
  const configured = String(process.env.SUDO || global.sudo || process.env.OWNER_NUMBER || global.owner || '')
  const number = configured.replace(/\D/g, '')
  return number ? `${number}@s.whatsapp.net` : null
}

function notifyConnectedOnce(socket) {
  if (connectedBannerSent || !socket?.ev?.on || typeof socket?.sendMessage !== 'function') return
  const recipient = sudoRecipient()
  if (!recipient) return
  let isConnectionOpen = false
  let sendAttempts = 0
  const maxAttempts = 30
  const liveSocket = () => (global.__saffulLatestSocket && typeof global.__saffulLatestSocket?.sendMessage === 'function' ? global.__saffulLatestSocket : socket)
  const sendBanner = async () => {
    if (connectedBannerSent) return
    if (!isConnectionOpen) return
    const current = liveSocket()
    if (!current?.user?.id) return
    sendAttempts += 1
    try {
      await current.sendMessage(recipient, { text: connectedBannerText() })
      connectedBannerSent = true
    } catch {}
  }
  socket.ev.on('connection.update', ({ connection } = {}) => {
    if (connection === 'open') {
      isConnectionOpen = true
      setTimeout(() => void sendBanner(), 3000)
    } else {
      isConnectionOpen = false
    }
  })
  const retry = setInterval(() => {
    if (connectedBannerSent || sendAttempts >= maxAttempts) { clearInterval(retry); return }
    void sendBanner()
  }, 5000)
  retry.unref?.()
}

let bootPhase = 'auth-prep'
let lastConnectionState = 'starting'
let startInFlight = false
let reconnectTimer = null
let shutdownRequested = false
let reconnectBlocked = false

const DO_NOT_RECONNECT_CODES = new Set([401, 403, 411, 500])

function disconnectCode(update = {}) {
  const error = update?.lastDisconnect?.error
  return Number(error?.output?.statusCode || error?.data?.statusCode || error?.statusCode || 0)
}

function scheduleReconnect(reason = 'connection closed', delay = 5000) {
  if (shutdownRequested || reconnectBlocked || reconnectTimer) return
  lastConnectionState = 'reconnecting'
  process.stdout.write(`[uptime] ${reason} — reconnecting in ${Math.ceil(delay / 1000)}s.\n`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (reconnectBlocked) return
    if (startInFlight) return scheduleReconnect('startup still busy', 3000)
    void start()
  }, delay)
}

function cancelScheduledReconnect() {
  if (!reconnectTimer) return
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  process.stdout.write('[uptime] Connection recovered — cancelled the fallback reconnect.\n')
}

global.__saffulRequestReconnect = (reason) => scheduleReconnect(reason, 1500)

const start = async () => {
  if (startInFlight || shutdownRequested) return
  startInFlight = true
  let bot
  try {
    // Restore session from PostgreSQL before auth prep
    try { await sessionGuard.restoreSession() } catch {}
    await prepareAuthentication()
    if (global.__saffulAuthMethod === 'existing') clearRecoveryState()
    process.stdout.write(`[boot] auth method: ${global.__saffulAuthMethod || 'unknown'} (pairing number: ${global.__saffulPairingNumber || 'n/a'})\n`)

    // ── Standalone pairing flow ───────────────────────────────────────
    // When the operator sets AUTH_METHOD=pairing, we run the pairing
    // bootstrap BEFORE loading the core. The bootstrap creates its own
    // baileys socket, requests the pairing code, and saves the session.
    // After success, we set auth method to 'existing' so the core
    // reconnects with the saved session.
    if (global.__saffulAuthMethod === 'pairing' && global.__saffulPairingNumber) {
      const { startCleanPairing } = require(__dirname + '/lib/safful-pairing-bootstrap')
      process.stdout.write('[boot] Starting standalone pairing flow…\n')
      try {
        await startCleanPairing(global.__saffulPairingNumber)
        process.stdout.write('[boot] Pairing succeeded — session saved. Loading core…\n')
        global.__saffulAuthMethod = 'existing'
        clearRecoveryState()
      } catch (pairError) {
        process.stdout.write(`[boot] Pairing failed: ${pairError?.message || pairError}\n`)
        process.stdout.write('[boot] Falling back to QR login…\n')
        global.__saffulAuthMethod = 'qr'
      }
    }
    // ──────────────────────────────────────────────────────────────────

    bootPhase = 'core-load'
    process.stdout.write('[boot] loading core module…\n')
    // Install temporary SPECTER banner catcher before smd.js loads
    const __preSmdWrite = process.stdout.write.bind(process.stdout)
    const __preSmdLog = console.log.bind(console)
    const specterCatch = (text) => /SPECTER|MULTIDEVICE.*WHATSAPP.*USER.*BOT/i.test(text)
    const blockCatch = (text) => /[╔╗╚╝║═]{4,}/.test(text)
    process.stdout.write = function(chunk, ...rest) {
      const t = typeof chunk === 'string' ? chunk : String(chunk)
      if (specterCatch(t) || blockCatch(t)) return true
      return __preSmdWrite(chunk, ...rest)
    }
    console.log = function(...args) {
      const t = args.map(a => typeof a === 'string' ? a : String(a)).join(' ')
      if (specterCatch(t) || blockCatch(t)) return
      return __preSmdLog(...args)
    }
    bot = require(__dirname + '/lib/smd')
    // Restore proper brand interceptors
    try {
      const bc = require(__dirname + '/lib/brand-console')
      if (process.__saffulStdoutInterceptor) process.stdout.write = process.__saffulStdoutInterceptor
      if (process.__saffulStderrInterceptor) process.stderr.write = process.__saffulStderrInterceptor
      if (process.__saffulConsoleLogInterceptor) console.log = process.__saffulConsoleLogInterceptor
    } catch {}
    // Load custom .js plugins explicitly
    const _ep = ['hacking-tools','auto-moderation','privacy-commands','ig-download','sports-live','snap-download','pin-download','spotify-download','zzzz-safful-song','yt-download','antiviewonce']
    for (const p of _ep) { try { require(__dirname + '/plugins/' + p) } catch (e) { process.stdout.write('[plugin] ' + p + ' err: ' + e.message + '\n') } }
    // Print QR to console when smd.js generates it (raw write — bypasses log filter)
    // Responsive: compact margin + auto-centering to the live terminal width
    try {
      if (!global.__saffulQrWatcherInstalled) {
        global.__saffulQrWatcherInstalled = true
        const qrcode = require('qrcode');
        const rawOut = process.__saffulRawStdout || process.stdout.write.bind(process.stdout);
        let _lastQr = '';
        const printQr = () => {
          if (!global.qr || global.qr === _lastQr) return
          _lastQr = global.qr;
          qrcode.toString(global.qr, {
            type: 'terminal',
            small: true,      // half-blocks → half the height, stays square
            margin: 1,        // tight quiet zone → fits narrow screens
          }, (err, str) => {
            if (err || !str) return;
            const cols = process.stdout.columns || 80;
            const lines = str.split('\n');
            // Measure VISIBLE width (strip ANSI escape codes) for correct centering
            const visibleLen = (l) => l.replace(/\x1b\[[0-9;]*m/g, '').length;
            const qrWidth = Math.max(...lines.map(visibleLen));
            const pad = qrWidth < cols ? Math.floor((cols - qrWidth) / 2) : 0;
            const centered = lines.map((l) => ' '.repeat(pad) + l).join('\n');
            rawOut('\n  ── Scan this QR with WhatsApp ──\n\n' + centered + '\n');
          });
        };
        setInterval(printQr, 2000).unref();
      }
    } catch (qrErr) { process.stdout.write('[boot] QR watcher failed: ' + qrErr.message + '\n') }
    process.stdout.write('[boot] core loaded\n')
    console.log(`Safful ${VERSION}`)

    bootPhase = 'session-init'
    process.stdout.write('[boot] initializing session…\n')
    await bot.init()
    process.stdout.write('[boot] session initialized\n')

    // Re-run the readable command replacements after every legacy bundle has
    // registered. This guarantees that the maintained handlers win over the
    // older generated/obfuscated implementations.
    for (const reliabilityPlugin of ['auto-moderation', 'safful-command-reliability', 'safful-group-reliability']) {
      const pluginPath = require.resolve(__dirname + '/plugins/' + reliabilityPlugin)
      delete require.cache[pluginPath]
      require(pluginPath)
    }
    const deduplication = require(__dirname + '/plugins/safful-command-reliability').deduplicateCommands()
    if (deduplication.removedCommands || deduplication.removedAliases) {
      process.stdout.write(`[boot] removed ${deduplication.removedCommands} duplicate commands and ${deduplication.removedAliases} duplicate aliases\n`)
    }
    process.stdout.write('[boot] command reliability replacements ready\n')

    bootPhase = 'database-sync'
    process.stdout.write('[boot] syncing database…\n')
    bot.logger.info('⏳ Database syncing!')
    await bot.DATABASE.sync()
    process.stdout.write('[boot] database ready\n')

    bootPhase = 'socket-create'
    process.stdout.write('[boot] connecting to WhatsApp…\n')
    try {
      const probe = await fetch('https://web.whatsapp.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      process.stdout.write(`[boot] WhatsApp reachable (HTTP ${probe.status})\n`)
    } catch (probeError) { process.stdout.write(`[boot] WARNING: cannot reach web.whatsapp.com — ${probeError?.message || probeError}\n`) }

    const socket = await bot.connect()
    sessionGuard.hookSocket(socket)
    process.stdout.write('[boot] socket created\n')

    const reportConnection = (update = {}) => {
      const state = String(update.connection || '')
      if (state === 'open') {
        reconnectBlocked = false
        cancelScheduledReconnect()
      }
      if (!state || state === lastConnectionState) return
      lastConnectionState = state
      const error = update.lastDisconnect?.error
      const reason = error ? ` — ${error?.message || error}` : ''
      process.stdout.write(`[boot] connection state: ${state}${reason}\n`)
    }
    socket.ev?.on?.('connection.update', reportConnection)

    socket.ev?.on?.('connection.update', ({ connection } = {}) => {
      if (connection === 'open') process.stdout.write('[boot] connection open\n')
    })

    socket.ev?.on?.('connection.update', (update = {}) => {
      if (update.connection !== 'close') return
      const code = disconnectCode(update)
      if (code === 440) {
        process.stdout.write('[uptime] An older socket was replaced; keeping the active connection without relinking.\n')
        return
      }
      if (DO_NOT_RECONNECT_CODES.has(code)) {
        reconnectBlocked = true
        process.stdout.write(`[uptime] Session closed with non-reconnectable code ${code}; manual relink required.\n`)
        return
      }
      // Baileys normally recycles a code-515 socket itself. The longer timer
      // is only a fallback and is cancelled as soon as that socket reopens.
      const delay = code === 515 ? 30000 : 10000
      scheduleReconnect(`WhatsApp disconnected${code ? ` (code ${code})` : ''}`, delay)
    })

    bootPhase = 'attach-hooks'
    attachProtection.installSocketRawCapture(socket)
    rebrandSocket(socket)
    preserveMobileNotifications(socket)
    attachRawDispatcher(socket, { attachProtection, autoView, statusSave })
    notifyConnectedOnce(socket)
    process.stdout.write('[boot] hooks attached — ready\n')

    // Register after the raw dispatcher so view-once wrappers are inspected
    // before the normal command serializer unwraps them.
    try {
      require(__dirname + '/plugins/antiviewonce').attach(socket)
    } catch (e) { process.stdout.write('[avo] Hook failed: ' + (e.message || e) + '\n') }

    // ── Auto-Moderation Hooks ────────────────────────────────────────────
    try {
      require(__dirname + '/plugins/auto-moderation').attach(socket)
      process.stdout.write('[automod] Auto-moderation hooks installed\n')
    } catch (e) { process.stdout.write('[automod] Hook failed: ' + e.message + '\n') }

    // Uptime Guardian activation
    const RECONNECTABLE_CODES = new Set([408, 428, 503, 515])
    let _guardianActivated = false
    socket.ev?.on?.('connection.update', (update = {}) => {
      if (update.connection === 'open') {
        reconnectBlocked = false
        if (!_guardianActivated) { _guardianActivated = true; global.__saffulUptimeSuppress(0) }
        global.__saffulUptimeReconnected()
      }
      if (_guardianActivated && update.connection === 'close') {
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode || update?.lastDisconnect?.error?.data?.statusCode
        if (RECONNECTABLE_CODES.has(statusCode)) {
          global.__saffulUptimeSuppress(15000)
          process.stdout.write(`[uptime] Reconnectable disconnect (code ${statusCode}) — suppressing exit for 15s.\n`)
        }
      }
    })

    // Memory Watchdog (installed once even when the socket reconnects)
    if (!global.__saffulMemoryWatchdogInstalled) {
      global.__saffulMemoryWatchdogInstalled = true
      const memoryCheck = setInterval(() => {
        const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        if (heapMB > 800) {
          process.stdout.write(`[uptime] High memory (${heapMB} MB) — trimming caches without rebooting.\n`)
          try { if (typeof global.__saffulStoreTrim === 'function') global.__saffulStoreTrim() } catch {}
          if (global.gc) global.gc()
        }
        else if (heapMB > 650) { try { if (typeof global.__saffulStoreTrim === 'function') global.__saffulStoreTrim() } catch {} ; if (global.gc) global.gc() }
        else if (heapMB > 500) { if (global.gc) global.gc() }
      }, 30 * 60 * 1000)
      memoryCheck.unref?.()
      const gcInterval = setInterval(() => { if (global.gc) global.gc() }, 6 * 60 * 60 * 1000)
      gcInterval.unref?.()
    }

  } catch (error) {
    process.stdout.write(`[boot] FAILED at '${bootPhase}': ${error?.stack || error}\n`)
    console.error('[startup] Failed to start Safful-Md:', error)
    if (global.__saffulAuthMethod === 'pairing') return
    scheduleReconnect(`startup failed at ${bootPhase}`, 3000)
  } finally {
    startInFlight = false
  }
}

// ── Stability: SIGTERM/SIGINT clean shutdown ──────────────────────────
function cleanShutdown(signal) {
  shutdownRequested = true
  process.stdout.write(`[uptime] ${signal} received — cleaning up...\n`)
  try { if (typeof sessionGuard?.backupNow === 'function') sessionGuard.backupNow() } catch {}
  try {
    const sock = global.__saffulLatestSocket
    if (sock && typeof sock.end === 'function') sock.end()
  } catch {}
  process.stdout.write('[uptime] Shutdown complete\n')
  process.exit(0)
}
process.on('SIGTERM', () => cleanShutdown('SIGTERM'))
process.on('SIGINT', () => cleanShutdown('SIGINT'))

// ── Stability: Express health endpoint for Pterodactyl ────────────────
try {
  const http = require('http')
  const healthPort = parseInt(process.env.PORT || '0') || 8080
  const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const isAlive = lastConnectionState === 'open'
      // Keep the process healthy while the WhatsApp socket is reconnecting.
      // Some Node panels kill and restart apps on any non-200 probe response.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: isAlive ? 'ok' : 'disconnected',
        connection: lastConnectionState,
        uptime: Math.floor(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        bot: 'Safful-MD',
      }))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })
  healthServer.listen(healthPort, '0.0.0.0', () => {
    process.stdout.write(`[health] Health server on http://0.0.0.0:${healthPort}/health\n`)
  })
  healthServer.on('error', (e) => {
    process.stdout.write('[health] Could not start health server: ' + e.message + '\n')
  })
} catch {}

// ── Stability: WhatsApp connection watchdog ────────────────────────────
setInterval(() => {
  try {
    if (lastConnectionState !== 'open' && !reconnectBlocked) {
      scheduleReconnect('watchdog found WhatsApp in state: ' + lastConnectionState, 1000)
    }
  } catch {}
}, 60 * 1000)

start()
