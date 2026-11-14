# THE GHANAIAN BOT

Use Node.js 22.12+ or 24, with FFmpeg installed.

1. Extract this ZIP into the deployment directory.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and set your `OWNER_NUMBER` and `SUDO` (country code included).
4. Run `npm start`, then link WhatsApp using the QR page or pairing method.
5. Preserve the session directory and `.safful-data` across restarts.

For two accounts, set `DEVICE_COUNT=2` and configure the `_2` variables from
`.env.example`. Preserve `.safful-devices` as well; it contains device 2's
session and local runtime state. Each device must use a different port.

The archive excludes local credentials, `.env`, runtime data and `node_modules`.

## Commands

- `.vcf`: silently export group contacts to the first configured sudo/owner chat.
- `.vcf csv` or `.vcf excel`: export an Excel-compatible CSV instead. This is CSV, not XLSX.
- Group members may invoke the export if the bot's command mode permits; the file always goes to the owner. `personal`/`me` also use the owner's destination.
- Unresolved LIDs are skipped and counted; hidden phone numbers are not invented. Names unavailable to WhatsApp use numbered group labels.
- `.rejectcall <number>`: reject that caller. `del <number>` or `clear` removes rules.
- `.blockcall <number>`: apply a WhatsApp block, affecting messages as well as calls. `del <number>` and `clear` also unblock numbers in this bot's list.
- `.calldnd on|off`: enable or disable rejection of all incoming calls. `.calldnd` shows counters.
- `.autoview on`: view statuses immediately; `.autoview 1` through `.autoview 10`: delay in minutes; `.autoview off`: disable. `.autoview 0` is rejected without changing the mode.
- `.antiviewonce on`, `.antiviewonce <number>`, `.antiviewonce status`: enable capture or inspect counters. Global `off` keeps individual contact rules; use `off <number>` to remove one.
- Reply to a view-once photo, video or voice note with `.kk` to send the available media to the first configured sudo/owner DM.
- `.savestatus on|off|status` (alias `.statussave`): forward new received contact statuses to sudo, with the contact name. Audio/stickers receive a separate name message. If WhatsApp provides no name, the sender ID is shown. The automatic saver processes one download at a time, up to 16 MB per item, and does not retain media on disk by itself. `.save` still saves an individual replied status.
- `.savedelstat on|off|status`: opt in to recovery of deleted statuses. It can recover only statuses received and cached while enabled. Cache limits are 64 MB per account (128 MB for two accounts), 16 MB per item, up to 200 items, and 24 hours. Oldest entries are evicted first; `off` clears this account's deleted-status cache. Settings and cache are isolated for each account.
- `.antidelete` supports forwarding available deleted stickers, audio/voice notes, images, videos and documents to sudo. Its view-once capture also preserves modern key flags and video notes. Media must reach the bot before deletion; notices without media cannot be reconstructed.

Call protection and media capture pause with `.chatbot off`. Handlers reattach after reconnects. View-once capture supports images, videos and voice notes when WhatsApp supplies the media. Failed downloads retry for five minutes. An unavailable notice without a media payload cannot itself be recovered; later payloads are processed if delivered.

## Updating a dual-session deployment

Use `.gitinit` (aliases `.gitsetup`, `.gitfix`) from either account to set up the
main Git checkout for a ZIP installation. `.gitninit` is not a command. Setup
fetches the published repository and preserves linked sessions; it does not
restart the workers. Local files that conflict with the checkout are backed up.

Then use `.update` from either account. It updates the main installation once,
installs dependencies, validates both linked sessions, and asks the launcher to
stop both workers and exit with code 1 so the panel can restart the deployment.
Device 2 receives the updated code on startup while retaining its session,
settings and cache. Only one repository operation can run at a time. An account
left unpaired does not prevent the other account from updating.

Root session folders and legacy `lib` session folders are recognized. Account 1
and account 2 have separate backups under their own `.safful-secrets` directories.
Backups are excluded from runtime copying and release ZIPs. Incoming repository
files cannot replace `.env`, sessions, backups, or the Device 2 runtime.

After installing this patch ZIP, restart the panel once to activate the new
launcher. If an older launcher is still running, `.update` asks for a panel
restart instead of restarting only one account. The panel must be configured to
restart a failed process; otherwise use its Start button after the update.

Both commands fetch **published GitHub code**. They cannot install unpublished
local patches. Use the provided ZIP until the new patch is pushed; running
`.gitinit` or pulling older published code can replace local patched files.

## Verification

Run `node --test tests/*.test.cjs` for regression tests. Tests cover contact resolution and private delivery, notification guards, call signaling, reconnect attachment, event buffering, media re-upload, autoview modes and retry queues. Network calls are simulated; these checks do not establish successful operation against a live WhatsApp account.
