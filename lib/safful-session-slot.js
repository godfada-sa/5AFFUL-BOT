'use strict'

// The upstream core has a legacy, hard-coded `Safful_Session` path in a few
// singleton modules. This preload changes that literal only for worker two.
// Each worker remains its own Node process, which is what isolates bot state.
const Module = require('module')
const path = require('path')

const configured = String(process.env.SAFFUL_SESSION_DIR || '/Safful_Session/').trim()
const normalized = configured.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
if (!/^Safful_Session(?:_[A-Za-z0-9_-]+)?$/.test(normalized)) {
  throw new Error('SAFFUL_SESSION_DIR must name a Safful_Session directory.')
}

if (normalized !== 'Safful_Session') {
  const originalCompile = Module.prototype._compile
  const target = new RegExp(`${path.sep.replace('\\', '\\\\')}lib${path.sep.replace('\\', '\\\\')}(?:smd|safful-(?:pairing-bootstrap|session-guard|rename-session))\\.js$`)
  Module.prototype._compile = function saffulSessionSlotCompile(content, filename) {
    if (target.test(filename)) {
      content = content.replace(/Safful_Session/g, normalized)
      // PostgreSQL is optional, but when used its auth backup must be just as
      // isolated as the on-disk credential directory.
      if (filename.endsWith(`${path.sep}safful-session-guard.js`)) {
        content = content.replace(/safful_session_backup/g, `safful_session_backup_${process.env.SAFFUL_SESSION_SLOT || '2'}`)
      }
    }
    return originalCompile.call(this, content, filename)
  }
}
