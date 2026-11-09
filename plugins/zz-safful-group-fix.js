'use strict'

// Compatibility entry retained for deployments that already load this file.
// The maintained patch performs a fresh LID/phone-aware metadata lookup using
// the actual live socket before group command handlers inspect admin flags.
const { commands } = require('../lib/plugins')
const { patchAdminCommands } = require('../lib/safful-admin-command-patch')

setImmediate(() => patchAdminCommands(commands))
