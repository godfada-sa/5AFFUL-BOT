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

Call protection and media capture pause with `.chatbot off`. Handlers reattach after reconnects. View-once capture supports images, videos and voice notes when WhatsApp supplies the media. Failed downloads retry for five minutes. An unavailable notice without a media payload cannot itself be recovered; later payloads are processed if delivered.

## Verification

Run `node --test tests/*.test.cjs` for regression tests. Tests cover contact resolution and private delivery, notification guards, call signaling, reconnect attachment, event buffering, media re-upload, autoview modes and retry queues. Network calls are simulated; these checks do not establish successful operation against a live WhatsApp account.
