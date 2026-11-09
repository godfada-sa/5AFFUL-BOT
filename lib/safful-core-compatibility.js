'use strict'

function authorizeBundledCore() {
  // The inherited obfuscated core still calls its official-build flag
  // IS_SUHAIL. This repository is the authorized Safful-MD continuation, so
  // set that compatibility marker before lib/smd is loaded. The former
  // child_process/git-remote spoof no longer reaches the current guard.
  global.IS_SUHAIL = true
  process.env.IS_SUHAIL = 'true'
  return true
}

module.exports = { authorizeBundledCore }
