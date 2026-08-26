// safful-rename-session.js
// Renames Suhail_Baileys session directory to Safful_Baileys
// and creates a backward-compatibility symlink.

const fs = require('fs')
const path = require('path')

const OLD_NAME = 'Suhail_Baileys'
const NEW_NAME = 'Safful_Session'
const LIB_DIR = __dirname

const oldPath = path.join(LIB_DIR, OLD_NAME)
const newPath = path.join(LIB_DIR, NEW_NAME)

try {
  // Case 1: old exists, new doesn't → rename old→new, create symlink old→new
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath)
    // Create symlink oldPath → points to NEW_NAME
    fs.symlinkSync(NEW_NAME, oldPath)
    console.log(`[safful] Renamed ${OLD_NAME} → ${NEW_NAME} and created compatibility symlink`)
  }
  // Case 2: both exist → remove old if it's a real dir, replace with symlink
  else if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
    const stat = fs.lstatSync(oldPath)
    if (!stat.isSymbolicLink()) {
      // oldPath is a real directory but newPath also exists
      // Remove oldPath (force) and create symlink in its place
      fs.rmSync(oldPath, { recursive: true, force: true })
      fs.symlinkSync(NEW_NAME, oldPath)
      console.log(`[safful] Replaced ${OLD_NAME} directory with symlink → ${NEW_NAME}`)
    }
    // If oldPath is already a symlink, leave it alone
  }
  // Case 3: neither exists → create new dir, create symlink old→new
  else if (!fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.mkdirSync(newPath, { recursive: true })
    fs.symlinkSync(NEW_NAME, oldPath)
    console.log(`[safful] Created ${NEW_NAME} directory and symlink ${OLD_NAME} → ${NEW_NAME}`)
  }
  // Case 4: only new exists → create compatibility symlink
  else if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
    fs.symlinkSync(NEW_NAME, oldPath)
    console.log(`[safful] Created compatibility symlink ${OLD_NAME} → ${NEW_NAME}`)
  }
} catch (err) {
  console.error('[safful] rename-session error:', err.message)
}
