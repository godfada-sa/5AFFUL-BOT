/**
 * safful-rename-session.js
 *
 * Renames the session folder from Suhail_Baileys to Safful_Baileys and creates
 * a symlink so the obfuscated code that still references the old name keeps working.
 *
 * Must be required BEFORE smd.js loads (e.g., from index.js or config.js).
 */

const fs = require('fs');
const path = require('path');

const OLD_NAME = 'Suhail_Baileys';
const NEW_NAME = 'Safful_Baileys';
const LIB_DIR = __dirname;

const oldPath = path.join(LIB_DIR, OLD_NAME);
const newPath = path.join(LIB_DIR, NEW_NAME);

try {
  // Case 1: Old folder exists, new doesn't → rename + symlink
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
    fs.symlinkSync(NEW_NAME, oldPath);
    console.log(`[safful] Renamed ${OLD_NAME} → ${NEW_NAME} (symlink created for compatibility)`);
  }
  // Case 2: Both exist → old is likely a stale symlink, just ensure symlink points to new
  else if (fs.existsSync(oldPath) && fs.existsSync(newPath)) {
    const stat = fs.lstatSync(oldPath);
    if (!stat.isSymbolicLink()) {
      // oldPath is a real directory AND newPath exists — remove old and symlink
      fs.rmSync(oldPath, { recursive: true, force: true });
      fs.symlinkSync(NEW_NAME, oldPath);
      console.log(`[safful] Replaced ${OLD_NAME} directory with symlink → ${NEW_NAME}`);
    }
    // else: symlink already exists, nothing to do
  }
  // Case 3: Neither exists → will be created later by the bot; pre-create with symlink
  else if (!fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.mkdirSync(newPath, { recursive: true });
    fs.symlinkSync(NEW_NAME, oldPath);
    console.log(`[safful] Created ${NEW_NAME} and symlink ${OLD_NAME} → ${NEW_NAME}`);
  }
  // Case 4: Only new exists (already migrated) → just ensure symlink
  else if (!fs.existsSync(oldPath) && fs.existsSync(newPath)) {
    fs.symlinkSync(NEW_NAME, oldPath);
    console.log(`[safful] Created compatibility symlink ${OLD_NAME} → ${NEW_NAME}`);
  }
} catch (err) {
  console.error(`[safful] Session rename failed (non-fatal):`, err.message);
}
