'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

test('E2E: update requested by device 2 stops both workers and exits the supervisor for panel restart', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-restart-all-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const output = path.join(scratch, 'workers.jsonl')
  const result = spawnSync(process.execPath, ['launcher.js'], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, DEVICE_COUNT: '2', SAFFUL_E2E_OUTPUT: output,
      SAFFUL_LAUNCHER_ONESHOT: 'false', SAFFUL_WORKER_ENTRY: 'tests/fixtures/deployment-restart-worker.cjs' },
  })
  assert.equal(result.status, 1, result.stderr || result.error?.message || result.stdout)
  assert.match(result.stdout, /stopping all account workers/)
  const workers = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(workers.length, 2)
  for (const worker of workers) assert.throws(() => process.kill(worker.pid, 0), /ESRCH/)
})

test('E2E: a stalled stream-ACK worker exits and the supervisor starts its replacement', { timeout: 55000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-ack-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const child = require('node:child_process').spawn(process.execPath, ['launcher.js'], {
    cwd: path.join(__dirname, '..'), windowsHide: true,
    env: { ...process.env, DEVICE_COUNT: '1', SAFFUL_E2E_OUTPUT: path.join(scratch, 'started'),
      SAFFUL_LAUNCHER_ONESHOT: 'false', SAFFUL_WORKER_ENTRY: 'tests/fixtures/ack-recovery-worker.cjs' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  let output = ''
  child.stderr.on('data', data => { output += data })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => reject(new Error('Supervisor exited before recovery')))
    child.stdout.on('data', data => {
      output += data
      if (output.includes('replacement worker ready')) resolve()
    })
  })
  assert.match(output, /code 500, stream ack class=status/)
  assert.match(output, /device 1 stopped \(1\)/)
})

test('E2E: supervisor launches two isolated account workers', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-e2e-'))
  const output = path.join(scratch, 'workers.jsonl')
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

  const root = path.join(__dirname, '..')
  const result = spawnSync(process.execPath, ['launcher.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      DEVICE_COUNT: '2',
      OWNER_NUMBER: '233500000001',
      OWNER_NUMBER_2: '233500000002',
      PORT: '8101',
      PORT_2: '8102',
      SAFFUL_E2E_OUTPUT: output,
      SAFFUL_LAUNCHER_ONESHOT: 'true',
      SAFFUL_WORKER_ENTRY: 'tests/fixtures/launcher-worker.cjs',
    },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const workers = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    .sort((left, right) => left.device.localeCompare(right.device))

  assert.equal(workers.length, 2)
  assert.deepEqual(workers.map((worker) => worker.device), ['1', '2'])
  assert.deepEqual(workers.map((worker) => worker.owner), ['233500000001', '233500000002'])
  assert.deepEqual(workers.map((worker) => worker.port), ['8101', '8102'])
  assert.notEqual(workers[0].runtime, workers[1].runtime)
  assert.match(workers[1].runtime, /[\\/]\.safful-devices[\\/]device-2$/)
})

test('E2E: direct panel entry through index.js still starts both workers', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-index-e2e-'))
  const output = path.join(scratch, 'workers.jsonl')
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))

  const root = path.join(__dirname, '..')
  const result = spawnSync(process.execPath, ['index.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: {
      ...process.env,
      DEVICE_COUNT: '2',
      PORT: '8201',
      PORT_2: '8202',
      SAFFUL_E2E_OUTPUT: output,
      SAFFUL_LAUNCHER_ONESHOT: 'true',
      SAFFUL_WORKER_ENTRY: 'tests/fixtures/launcher-worker.cjs',
    },
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /DEVICE_COUNT=2 detected through index\.js/)
  const workers = fs.readFileSync(output, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
  assert.equal(workers.length, 2)
  assert.deepEqual(workers.map(worker => worker.device).sort(), ['1', '2'])
})
