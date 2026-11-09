'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const BAILEYS_DIR = path.join(ROOT, 'Safful_Session')
const deviceId = String(process.env.SAFFUL_DEVICE_ID || '1').replace(/\D/g, '') || '1'
const TABLE = deviceId === '1' ? 'safful_session_backup' : `safful_session_backup_d${deviceId}`
let pool = null

function log(message) {
  process.stdout.write(`[session-guard] ${message}\n`)
}

function getPool() {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL || global.DATABASE_URL
  if (!connectionString) return null
  const { Pool } = require('pg')
  pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 2 })
  return pool
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      filename TEXT PRIMARY KEY,
      data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
}

async function backupSession() {
  const client = getPool()
  if (!client) return log('no DATABASE_URL — skip backup')
  try {
    if (!fs.existsSync(BAILEYS_DIR)) return
    const names = fs.readdirSync(BAILEYS_DIR)
    if (!names.length) return
    await ensureTable(client)
    const currentFiles = new Set()
    let saved = 0
    for (const filename of names) {
      try {
        const file = path.join(BAILEYS_DIR, filename)
        if (!fs.statSync(file).isFile()) continue
        await client.query(
          `INSERT INTO ${TABLE} (filename, data, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (filename) DO UPDATE SET data = $2, updated_at = NOW()`,
          [filename, fs.readFileSync(file)]
        )
        currentFiles.add(filename)
        saved += 1
      } catch {}
    }
    await client.query(`DELETE FROM ${TABLE} WHERE filename != ALL($1::text[])`, [[...currentFiles]])
    log(`backed up ${saved} session files to PostgreSQL (device ${deviceId})`)
  } catch (error) {
    log(`backup failed: ${error?.message || error}`)
  }
}

async function restoreSession() {
  const client = getPool()
  if (!client) {
    log('no DATABASE_URL — skip restore')
    return false
  }
  try {
    const credentialsFile = path.join(BAILEYS_DIR, 'creds.json')
    if (fs.existsSync(credentialsFile)) {
      try {
        const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'))
        if (credentials?.account || credentials?.me) return false
      } catch {}
    }
    await ensureTable(client)
    const result = await client.query(`SELECT filename, data FROM ${TABLE}`)
    if (!result.rows.length) return false
    fs.mkdirSync(BAILEYS_DIR, { recursive: true })
    for (const row of result.rows) {
      fs.writeFileSync(path.join(BAILEYS_DIR, path.basename(row.filename)), row.data)
    }
    log(`restored ${result.rows.length} session files from PostgreSQL (device ${deviceId})`)
    return true
  } catch (error) {
    log(`restore failed: ${error?.message || error}`)
    return false
  }
}

function hookSocket(socket) {
  if (!socket?.ev) return
  socket.ev.on('creds.update', () => { void backupSession() })
  socket.ev.on('connection.update', (update = {}) => {
    if (update.connection === 'open') void backupSession()
  })
  log(`hooked — device ${deviceId} session auto-backs up on every update`)
}

module.exports = { backupSession, restoreSession, hookSocket }
