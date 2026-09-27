#!/usr/bin/env node
'use strict'

// Runs two isolated copies of the bot under one Node.js-panel process.  The
// application itself is singleton-heavy, so separate child processes are the
// safe boundary: sockets, globals, QR values, and reconnect loops cannot leak
// between accounts.
const { fork } = require('child_process')
const path = require('path')

const root = __dirname
const basePort = Number.parseInt(process.env.PORT || '8001', 10)
const slots = [
  {
    id: '1',
    label: 'primary',
    // This is deliberately the existing location. Enabling dual mode must
    // never invalidate the account that is already paired.
    sessionDir: '/Safful_Session/',
    port: basePort,
    authMethod: process.env.AUTH_METHOD || 'existing',
    pairingNumber: process.env.PAIRING_NUMBER || ''
  },
  {
    id: '2',
    label: 'secondary',
    sessionDir: '/Safful_Session_2/',
    port: Number.parseInt(process.env.PORT_2 || String(basePort + 1), 10),
    // A blank secondary account should show a QR. It can be changed to
    // `pairing` independently with AUTH_METHOD_2 and PAIRING_NUMBER_2.
    authMethod: process.env.AUTH_METHOD_2 || 'qr',
    pairingNumber: process.env.PAIRING_NUMBER_2 || ''
  }
]

if (!Number.isInteger(basePort) || basePort < 1 || basePort > 65534 || slots[1].port === basePort) {
  throw new Error('PORT and PORT_2 must be distinct valid TCP ports.')
}

const children = new Map()
let shuttingDown = false

function start(slot) {
  const env = {
    ...process.env,
    PORT: String(slot.port),
    AUTH_METHOD: slot.authMethod,
    PAIRING_NUMBER: slot.pairingNumber,
    SAFFUL_MULTI_SESSION_WORKER: '1',
    SAFFUL_SESSION_SLOT: slot.id,
    SAFFUL_SESSION_DIR: slot.sessionDir,
    // The preload redirects only the session-related paths in the legacy core.
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${path.join(root, 'lib', 'safful-session-slot.js')}`]
      .filter(Boolean)
      .join(' ')
  }
  const child = fork(path.join(root, 'index.js'), [], { cwd: root, env, stdio: 'inherit' })
  children.set(slot.id, child)
  console.log(`[multi-session] ${slot.label} started (session ${slot.sessionDir}, port ${slot.port}).`)
  child.once('exit', (code, signal) => {
    children.delete(slot.id)
    if (shuttingDown) return
    console.error(`[multi-session] ${slot.label} exited (${signal || code}); restarting in 3 seconds.`)
    setTimeout(() => start(slot), 3000).unref()
  })
}

function stop(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[multi-session] ${signal} received; stopping both sessions.`)
  for (const child of children.values()) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 8000).unref()
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
slots.forEach(start)
