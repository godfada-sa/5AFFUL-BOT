'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const qrcode = require('qrcode')
const {
  isQrOutput,
  renderCompactTerminalQr,
  renderTerminalQr,
} = require('../lib/safful-terminal-qr')

test('large ANSI-space QR output is suppressed alongside block QR output', () => {
  const ansiRow = ('\x1b[47m  \x1b[40m  ').repeat(8) + '\x1b[0m'
  const largeQr = Array(10).fill(ansiRow).join('\n')

  assert.equal(isQrOutput(largeQr), true)
  assert.equal(isQrOutput('██████ finder pattern'), true)
  assert.equal(isQrOutput('\x1b[32mordinary coloured status\x1b[0m'), false)
})

test('replacement QR uses the compact terminal renderer with no added indentation', async () => {
  const payload = '2@abc,012345678901234567890123456789012345678901234567890123456789,abcdef0123456789'
  const rendered = await renderCompactTerminalQr(qrcode, payload)

  assert.ok(rendered.rows <= 22, `expected compact height, got ${rendered.rows}`)
  assert.ok(rendered.width <= 40, `expected compact width, got ${rendered.width}`)
  assert.equal(rendered.output.split('\n').some((line) => /^ {4}/.test(line)), false)
  assert.equal(rendered.mode, 'standard')
  assert.doesNotMatch(rendered.output, /[\u2800-\u28ff]/)
})

test('stale braille settings are ignored and standard QR output is enforced', async () => {
  const payload = '2@abc,' + 'B'.repeat(120)
  const previousMode = process.env.QR_CONSOLE_MODE
  process.env.QR_CONSOLE_MODE = 'braille'

  try {
    const rendered = await renderTerminalQr(qrcode, payload)
    assert.equal(rendered.mode, 'standard')
    assert.doesNotMatch(rendered.output, /[\u2800-\u28ff]/)
    assert.match(rendered.output, /[█▄▀]/)
  } finally {
    if (previousMode === undefined) delete process.env.QR_CONSOLE_MODE
    else process.env.QR_CONSOLE_MODE = previousMode
  }
})

test('low error correction keeps the standard QR no larger than medium correction', async () => {
  const payload = '2@abc,' + 'C'.repeat(180)
  const low = await renderCompactTerminalQr(qrcode, payload, { errorCorrectionLevel: 'L' })
  const medium = await renderCompactTerminalQr(qrcode, payload, { errorCorrectionLevel: 'M' })

  assert.ok(low.rows <= medium.rows)
  assert.ok(low.width <= medium.width)
})
