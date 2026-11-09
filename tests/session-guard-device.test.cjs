'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('device 2 runtime contains per-device PostgreSQL backup isolation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'safful-session-guard-v2.js'), 'utf8')
  assert.match(source, /safful_session_backup_d\$\{deviceId\}/)
  assert.match(source, /SAFFUL_DEVICE_ID/)
})
