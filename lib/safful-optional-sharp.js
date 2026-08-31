'use strict'

// Image commands must either use the real Sharp module or report a clear
// dependency error. Returning a mock object here made `require('sharp')`
// succeed, then caused every caller to fail later with “sharp is not a
// function”. Sharp is a required dependency of this bot.
try {
  const sharp = require('sharp')
  if (typeof sharp !== 'function') throw new TypeError('Sharp did not export a function')
  module.exports = sharp
} catch (error) {
  const detail = error?.message || String(error)
  throw new Error(`Sharp could not be loaded. Run npm install before starting the bot. (${detail})`)
}
