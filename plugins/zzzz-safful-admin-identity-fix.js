'use strict'

const { commands } = require('../lib/plugins')
const { handlerKey, patchAdminCommands: patchRegistry } = require('../lib/safful-admin-command-patch')

function patchAdminCommands(registry = commands) {
  return patchRegistry(registry)
}

setImmediate(() => {
  const patched = patchAdminCommands()
  if (patched) console.log(`[safful-admin] refreshed identity checks for ${patched} group commands`)
})

module.exports = { handlerKey, patchAdminCommands }
