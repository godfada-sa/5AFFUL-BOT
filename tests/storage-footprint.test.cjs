'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('production dependencies do not install an unused Chromium browser', () => {
  const root = path.join(__dirname, '..')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(Object.hasOwn(manifest.dependencies || {}, 'puppeteer'), false)
})
