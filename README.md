# 5AFFUL BOT V3.6

Safful-Md is a WhatsApp multi-device bot powered by Baileys.

## Requirements

- Node.js 22 LTS
- FFmpeg
- A WhatsApp account to link

## Local setup

```bash
npm ci
cp .env.example .env
npm start
```

The first launch starts a new WhatsApp pairing flow. Once linked, normal
restarts automatically retain the local credentials. To link a different
account, stop the bot and remove only that device's session directory before
starting it.

## Two WhatsApp accounts

Set `DEVICE_COUNT=2` in `.env`. Device 1 keeps the normal settings and existing
session. Configure device 2 with the `_2` variables shown in `.env.example`,
especially a unique `PORT_2`, owner number and pairing number. The second
account is stored under `.safful-devices/device-2` and survives restarts.

Both accounts run in isolated Node.js processes so credentials, sockets,
plugins and runtime state cannot overwrite each other. Set `DEVICE_COUNT=1`
to return to the original single-account mode without deleting device 2.

## Ubuntu AWS deployment

The bot should run as the regular `ubuntu` user under a systemd service. Do
not expose its configured `PORT` to the internet; WhatsApp uses outbound
connections and the local HTTP server is only for process diagnostics.

1. Install Node.js 22, FFmpeg, Git, and build tools.
2. Clone this private repository into `/home/ubuntu/apps/saffulbot-device1`.
3. Copy `.env.example` to `.env` and set the owner number, sudo number, and a
   unique local port (for example `8001`).
4. Start the service and view the pairing code with:

   ```bash
   sudo journalctl -u saffulbot-device1 -f
   ```

5. After pairing, simply restart the service when needed; its local session is
   retained automatically.

For a second WhatsApp account in the same deployment, use `DEVICE_COUNT=2` and
the `_2` settings above. Never copy one device's credentials into the other.

## Security

- `.env`, sessions, QR images, logs, chat state, and live protection settings
  are excluded from Git.
- Keep this repository private.
- Use a different `OWNER_NUMBER` and `SUDO` value for each customer deployment.
