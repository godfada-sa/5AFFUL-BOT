const fs = require('fs')
const path = require('path')

function createSessionStore(projectRoot = path.resolve(__dirname, '..')) {
  const root = path.resolve(projectRoot)
  const sessionDir = path.join(root, 'lib', 'Safful_Session')
  const legacySessionDir = path.join(root, 'lib', 'Suhail_Baileys')
  const backupRoot = path.join(root, '.safful-secrets', 'session-backups')

  function isInsideRoot(candidate, expectedRoot) {
    const relative = path.relative(path.resolve(expectedRoot), path.resolve(candidate))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  function usableCredentials(directory) {
    try {
      const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'creds.json'), 'utf8'))
      return Boolean(credentials?.registered || credentials?.account || credentials?.me?.id)
    } catch {
      return false
    }
  }

  function currentSessionDirectory() {
    if (usableCredentials(sessionDir)) return sessionDir
    if (usableCredentials(legacySessionDir)) return legacySessionDir
    return null
  }

  function snapshot(label = 'manual') {
    const source = currentSessionDirectory()
    if (!source) return { saved: false, reason: 'No usable local WhatsApp session was found.' }

    fs.mkdirSync(backupRoot, { recursive: true })
    const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'backup'
    const folder = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}`
    const destination = path.join(backupRoot, folder, 'session')
    if (!isInsideRoot(destination, backupRoot)) throw new Error('Unsafe session backup path')
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true, dereference: true, errorOnExist: true })
    return { saved: true, directory: destination }
  }

  function availableBackups() {
    try {
      return fs.readdirSync(backupRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(backupRoot, entry.name, 'session'))
        .filter(usableCredentials)
        .sort((left, right) => right.localeCompare(left))
    } catch {
      return []
    }
  }

  function restoreLatestIfNeeded() {
    const current = currentSessionDirectory()
    if (current) return { restored: false, current: true, directory: current }

    const source = availableBackups()[0]
    if (!source) return { restored: false, current: false, reason: 'No usable session backup was found.' }

    fs.mkdirSync(backupRoot, { recursive: true })
    if (fs.existsSync(sessionDir)) {
      const displaced = path.join(backupRoot, `${Date.now()}-incomplete-session`)
      if (!isInsideRoot(displaced, backupRoot)) throw new Error('Unsafe session recovery path')
      fs.renameSync(sessionDir, displaced)
    }
    fs.mkdirSync(path.dirname(sessionDir), { recursive: true })
    fs.cpSync(source, sessionDir, { recursive: true, dereference: true, errorOnExist: true })
    if (!usableCredentials(sessionDir)) throw new Error('Session backup failed validation after restore')
    return { restored: true, current: true, directory: sessionDir }
  }

  return {
    backupRoot,
    currentSessionDirectory,
    restoreLatestIfNeeded,
    sessionDir,
    snapshot,
    usableCredentials,
  }
}

module.exports = {
  createSessionStore,
  ...createSessionStore(),
}
