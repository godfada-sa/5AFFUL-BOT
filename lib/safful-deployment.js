'use strict'

const fs = require('fs')
const path = require('path')

function deploymentRoot(runtime = path.resolve(__dirname, '..')) {
  const root = path.resolve(runtime)
  const parent = path.dirname(root)
  return path.basename(parent) === '.safful-devices' && /^device-[12]$/.test(path.basename(root))
    ? path.dirname(parent) : root
}

function protectedUpdatePath(name) {
  const parts = String(name).replace(/\\/g, '/').split('/')
  return parts.some(part => /^(?:\.git|\.safful-data|\.safful-secrets|\.safful-devices|\.safful-quarantine|node_modules|Safful_Session|Safful_Baileys|Suhail_Baileys|creds\.json)$/i.test(part)) ||
    parts.some(part => /^\.env(?:\.|$)/i.test(part) && part !== '.env.example')
}

// One update at a time across both worker processes. Recover a leftover lock
// only when its owning process no longer exists.
function acquireUpdateLock(root = deploymentRoot()) {
  const filename = path.join(root, '.safful-data', 'deployment-update.lock')
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  let handle
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = fs.openSync(filename, 'wx'); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let pid
      try { pid = JSON.parse(fs.readFileSync(filename, 'utf8')).pid } catch {}
      if (attempt === 0 && Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0) } catch (check) {
          if (check.code === 'ESRCH') {
            try { fs.unlinkSync(filename) } catch (remove) { if (remove.code !== 'ENOENT') throw remove }
            continue
          }
        }
      }
      throw Error('A repository operation is already running for this deployment. Wait for it to finish.')
    }
  }
  try { fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })) }
  catch (error) { fs.closeSync(handle); fs.unlinkSync(filename); throw error }
  return () => {
    fs.closeSync(handle)
    try { fs.unlinkSync(filename) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

module.exports = { deploymentRoot, protectedUpdatePath, acquireUpdateLock }
