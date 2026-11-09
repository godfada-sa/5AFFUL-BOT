'use strict'

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

function isQrOutput(value) {
  const text = String(value || '')
  if (/[█▄▀]{6,}/.test(text)) return true

  // qrcode's full-size terminal renderer draws modules as coloured spaces.
  // It therefore contains no block characters for the legacy detector to
  // find, but it does contain many background-colour transitions per row.
  const backgroundRuns = text.match(/\x1b\[(?:40|47|100|107)m/g) || []
  const rows = text.split(/\r?\n/).filter((row) => /\x1b\[(?:40|47|100|107)m/.test(row))
  return backgroundRuns.length >= 24 && rows.length >= 8
}

function visibleLength(line) {
  return String(line).replace(ANSI_PATTERN, '').length
}

function renderCompactTerminalQr(qrcode, value, options = {}) {
  const errorCorrectionLevel = String(
    options.errorCorrectionLevel || process.env.QR_ERROR_CORRECTION || 'L',
  ).toUpperCase()

  return new Promise((resolve, reject) => {
    qrcode.toString(value, {
      type: 'terminal',
      small: true,
      margin: 1,
      errorCorrectionLevel,
    }, (error, output) => {
      if (error) return reject(error)
      if (!output) return reject(new Error('QR renderer returned no output'))

      const lines = output.replace(/\s+$/, '').split(/\r?\n/)
      resolve({
        output: lines.join('\n'),
        rows: lines.length,
        width: Math.max(...lines.map(visibleLength)),
        mode: 'standard',
      })
    })
  })
}

function renderTerminalQr(qrcode, value, options = {}) {
  // Always use qrcode's standards-compliant terminal renderer. Braille packs
  // multiple QR modules into one glyph, which looks smaller but cannot be
  // scanned reliably from browser-based hosting consoles.
  return renderCompactTerminalQr(qrcode, value, options)
}

module.exports = {
  isQrOutput,
  renderCompactTerminalQr,
  renderTerminalQr,
  visibleLength,
}
