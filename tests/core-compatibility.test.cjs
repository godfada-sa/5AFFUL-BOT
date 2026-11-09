'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('authorized core marker is installed before the obfuscated core loads', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const marker = source.indexOf("safful-core-compatibility').authorizeBundledCore()")
  const core = source.indexOf("require(__dirname + '/lib/smd')")
  assert.ok(marker >= 0)
  assert.ok(core > marker)
})

test('real core init no longer exits with the modified-version guard', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-core-init-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

  const result = spawnSync(process.execPath, ['tests/fixtures/core-init-smoke.cjs'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, SAFFUL_E2E_SESSION_ROOT: scratch },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /SAFFUL_CORE_INIT_OK/)
  assert.doesNotMatch(result.stdout + result.stderr, /Modified Version/i)
})
