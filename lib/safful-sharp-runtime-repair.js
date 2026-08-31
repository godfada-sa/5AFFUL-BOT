'use strict'

const { spawnSync } = require('child_process')
const path = require('path')

const projectRoot = path.join(__dirname, '..')

function canLoadFormatterSharp() {
  try {
    const sharp = require('wa-sticker-formatter/node_modules/sharp')
    return typeof sharp === 'function'
  } catch {
    return false
  }
}

function ensureSharpRuntime() {
  if (canLoadFormatterSharp()) return true

  // A panel can preserve node_modules after changing OS/Node images. Sharp is
  // native, so rebuild its exact dependency before plugins are loaded.
  process.stdout.write('[startup] Sticker Sharp binary is missing — repairing native dependencies…\n')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const repair = spawnSync(npm, ['rebuild', 'sharp', '--foreground-scripts'], {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
  })

  if (repair.error || repair.status !== 0 || !canLoadFormatterSharp()) {
    const reason = repair.error?.message || `npm rebuild exited with code ${repair.status}`
    throw new Error(`Sticker Sharp repair failed: ${reason}`)
  }
  process.stdout.write('[startup] Sticker Sharp native dependency repaired.\n')
  return true
}

module.exports = { ensureSharpRuntime }
