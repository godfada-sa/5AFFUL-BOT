# Safful-Md

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
account, stop the bot and remove only `lib/Suhail_Baileys` before starting it.

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

For each additional WhatsApp account, create a new clone, `.env`, port, and
systemd service. Never copy another bot's `lib/Suhail_Baileys` credentials.

## Security

- `.env`, sessions, QR images, logs, chat state, and live protection settings
  are excluded from Git.
- Keep this repository private.
- Use a different `OWNER_NUMBER` and `SUDO` value for each customer deployment.
