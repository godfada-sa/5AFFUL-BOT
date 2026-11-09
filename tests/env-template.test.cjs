'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

function parseTemplate() {
  const text = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8')
  const lines = text.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  const pairs = lines.map((line) => line.split('=', 1)[0])
  const values = new Map(lines.map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  return { pairs, keys: new Set(pairs), text, values }
}

test('full env template has unique keys and complete two-device settings', () => {
  const { pairs, keys } = parseTemplate()
  assert.equal(keys.size, pairs.length, 'environment keys must not be duplicated')
  for (const key of [
    'DEVICE_COUNT', 'OWNER_NUMBER', 'SUDO', 'AUTH_METHOD', 'PORT',
    'OWNER_NUMBER_2', 'SUDO_2', 'AUTH_METHOD_2', 'PORT_2',
    'PREFIX', 'MODE', 'THEME', 'TZ', 'DATABASE_URL', 'MONGODB_URI',
  ]) assert.equal(keys.has(key), true, `missing ${key}`)
})

test('full env template contains placeholders rather than live credentials', () => {
  const { text, values } = parseTemplate()
  const sensitive = [...values.keys()].filter((key) =>
    key.endsWith('API_KEY') || ['DATABASE_URL', 'DATABASE_URL_2', 'MONGODB_URI', 'MONGODB_URI_2', 'SESSION_ID'].includes(key)
  )
  for (const key of sensitive) assert.equal(values.get(key), '', `${key} must be blank`)
  assert.match(text, /OWNER_NUMBER=233XXXXXXXXX/)
})
