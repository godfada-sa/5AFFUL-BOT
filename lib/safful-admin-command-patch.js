'use strict'

const { refreshAdminFlags } = require('./safful-admin-resolver')

const PATCHED = Symbol.for('safful.adminIdentityPatched')

function handlerKey(command) {
  for (const key of ['function', 'handler', 'run']) {
    if (typeof command?.[key] === 'function') return key
  }
  return Object.keys(command || {}).find((key) => typeof command[key] === 'function') || ''
}

function patchAdminCommands(registry) {
  let patched = 0
  for (const command of registry || []) {
    if (!/group\.smd$/i.test(String(command?.filename || ''))) continue
    const key = handlerKey(command)
    const original = key && command[key]
    if (!original || original[PATCHED]) continue

    const wrapped = async function (message, text, meta) {
      await refreshAdminFlags(message, meta)
      return original.call(this, message, text, meta)
    }
    Object.defineProperty(wrapped, PATCHED, { value: true })
    command[key] = wrapped
    patched += 1
  }
  return patched
}

module.exports = { handlerKey, patchAdminCommands }
