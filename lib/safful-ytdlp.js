const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const PROXY_CACHE = path.join(ROOT, '.safful-temp', '.working-proxy');
const MAX_SIZE = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const YTDLP_DL_TIMEOUT = 60000;

// Instant logging (panels may buffer console output)
function log(msg) { process.stderr.write('[safful-ytdlp] ' + msg + '\n'); }

// ═══════════════════════════════════════════════════════════════════════
//  yt-dlp finder + auto-download
// ═══════════════════════════════════════════════════════════════════════

let _ytDlpPath = null;
let _downloading = null;

function findYtdlp() {
  if (_ytDlpPath && fs.existsSync(_ytDlpPath)) return _ytDlpPath;

  const env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (env && fs.existsSync(env)) { _ytDlpPath = env; return env; }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    ...(process.platform !== 'win32' ? [tryWhich('yt-dlp')] : [tryWhere('yt-dlp')]),
    path.join(SECRETS_DIR, `yt-dlp${ext}`),
    path.join(ROOT, `yt-dlp${ext}`),
  ].filter(Boolean);

  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) { _ytDlpPath = p; return p; } } catch {}
  }
  return null;
}

function tryWhich(cmd) {
  try { return require('child_process').execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch { return null; }
}

function tryWhere(cmd) {
  try { return require('child_process').execSync(`where ${cmd} 2>nul`, { encoding: 'utf8' }).trim().split(/\r?\n/)[0]; } catch { return null; }
}

function getDownloadUrl() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  if (isWin) return `${base}/yt-dlp.exe`;
  if (isMac) return `${base}/yt-dlp_macos`;
  return `${base}/yt-dlp`;
}

async function ensureYtdlp() {
  if (findYtdlp()) return _ytDlpPath;
  if (_downloading) return _downloading;

  _downloading = (async () => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const dest = path.join(SECRETS_DIR, `yt-dlp${ext}`);

    log('yt-dlp not found, downloading from GitHub...');
    await fs.promises.mkdir(SECRETS_DIR, { recursive: true });

    const url = getDownloadUrl();
    log('Downloading from: ' + url);
    const res = await fetch(url, { timeout: YTDLP_DL_TIMEOUT, redirect: 'follow' });
    if (!res.ok) throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);

    const tmpDest = dest + '.tmp';
    await pipeline(res.body, fs.createWriteStream(tmpDest));
    await fs.promises.rename(tmpDest, dest);

    if (process.platform !== 'win32') {
      await fs.promises.chmod(dest, 0o755);
    }

    const stat = await fs.promises.stat(dest);
    log('Downloaded yt-dlp: ' + (stat.size / 1024 / 1024).toFixed(1) + ' MB');
    _ytDlpPath = dest;
    return dest;
  })().catch(err => { _downloading = null; throw err; });

  return _downloading;
}

// ═══════════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════════

function guessMime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
           '.ogg': 'audio/ogg', '.webm': 'audio/webm' }[ext] || 'audio/mpeg';
}

function runYtdlp(args, timeout = 90000) {
  const bin = findYtdlp();
  if (!bin) return Promise.reject(new Error('yt-dlp not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || 'yt-dlp error').trim().slice(0, 500)));
        resolve(String(stdout || ''));
      });
  });
}

function getConfiguredCookies() {
  const env = String(process.env.SAFFUL_YT_COOKIES || '').trim();
  if (!env) return null;
  const cookiePath = path.isAbsolute(env) ? env : path.join(ROOT, env);
  if (!fs.existsSync(cookiePath)) return null;
  return cookiePath;
}

function buildArgs(url, proxy, opts = {}) {
  const args = [
    '--no-warnings', '--no-check-certificates', '--geo-bypass', '--no-playlist',
    '--socket-timeout', '15', '--retries', '1', '--max-filesize', String(MAX_SIZE),
    '-f', 'bestaudio/ba]/best',
  ];
  // Try specified client or default
  const client = opts.client || 'tv_embedded';
  args.push('--extractor-args', `youtube:player_client=${client}`);
  args.push('-o', path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s'));
  if (proxy) args.push('--proxy', proxy);
  if (opts.withCookies) {
    const cookies = getConfiguredCookies();
    if (cookies) args.push('--cookies', cookies);
  }
  args.push('--user-agent', UA);
  args.push(url);
  return args;
}

async function parseOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const downloaded = lines.reverse().find(l => l && fs.existsSync(l));
  if (downloaded) {
    const stat = await fs.promises.stat(downloaded);
    if (stat.size > 0 && stat.size <= MAX_SIZE) {
      return { filePath: downloaded, mimeType: guessMime(downloaded) };
    }
  }
  try {
    const files = await fs.promises.readdir(TEMP_DIR);
    const candidates = [];
    for (const f of files) {
      if (f.endsWith('.part') || f.endsWith('.temp')) continue;
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = await fs.promises.stat(fp);
        if (stat.size > 1024 && stat.size <= MAX_SIZE) candidates.push({ fp, stat });
      } catch {}
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (candidates.length > 0) return { filePath: candidates[0].fp, mimeType: guessMime(candidates[0].fp) };
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Proxy discovery
// ═══════════════════════════════════════════════════════════════════════

async function fetchProxies() {
  const sources = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  ];
  const proxies = [];
  for (const src of sources) {
    try {
      const res = await fetch(src, { timeout: 8000 });
      if (!res.ok) continue;
      const text = await res.text();
      text.split('\n').forEach(l => {
        const t = l.trim();
        if (t && !t.startsWith('#') && t.includes(':')) proxies.push(t);
      });
    } catch {}
  }
  return [...new Set(proxies)];
}

async function testProxy(proxy) {
  const url = proxy.includes('://') ? proxy : 'socks5://' + proxy;
  try {
    await runYtdlp(['--proxy', url, '--no-warnings', '--no-check-certificates',
      '--socket-timeout', '8', '--retries', '0', '--get-title',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 12000);
    return url;
  } catch { return null; }
}

async function findWorkingProxy() {
  try {
    const cached = fs.readFileSync(PROXY_CACHE, 'utf8').trim();
    if (cached) {
      log('Testing cached proxy: ' + cached);
      const result = await testProxy(cached);
      if (result) { log('Cached proxy OK'); return result; }
      log('Cached proxy stale');
      try { fs.unlinkSync(PROXY_CACHE); } catch {}
    }
  } catch {}

  log('Fetching proxy lists...');
  const proxies = await fetchProxies();
  log('Found ' + proxies.length + ' proxies, testing...');

  for (let i = 0; i < Math.min(proxies.length, 50); i += 5) {
    const batch = proxies.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(p => testProxy(p)));
    const working = results.find(r => r.status === 'fulfilled' && r.value);
    if (working) {
      const proxy = working.value;
      log('Working proxy found: ' + proxy);
      try { fs.mkdirSync(path.dirname(PROXY_CACHE), { recursive: true }); fs.writeFileSync(PROXY_CACHE, proxy, 'utf8'); } catch {}
      return proxy;
    }
  }
  log('No working proxy found');
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Try download with a specific client
// ═══════════════════════════════════════════════════════════════════════

async function tryDownload(url, proxy, opts = {}) {
  const stdout = await runYtdlp(buildArgs(url, proxy, opts), 60000);
  const result = await parseOutput(stdout);
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════

async function downloadAudio(url) {
  await ensureYtdlp();
  const bin = findYtdlp();
  if (!bin) throw new Error('yt-dlp not found and auto-download failed.');
  log('Using: ' + bin);

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });

  // Clients to try (each may work on different servers)
  const clients = ['tv_embedded', 'web', 'mweb'];

  // ── Stage 1: Direct download with each client ──────────────────────
  for (const client of clients) {
    log('Trying direct (' + client + ')...');
    try {
      const result = await tryDownload(url, null, { client });
      if (result) {
        log('Direct OK (' + client + '): ' + (fs.statSync(result.filePath).size / 1024).toFixed(1) + ' KB');
        return result;
      }
    } catch (err) {
      const msg = String(err.message || '').slice(0, 120);
      log('Direct failed (' + client + '): ' + msg);
      if (/unavailable|Private video|removed|age-restricted|not available/i.test(msg)) throw err;
    }
  }

  // ── Stage 2: Direct with cookies ───────────────────────────────────
  if (getConfiguredCookies()) {
    for (const client of clients) {
      log('Trying cookies (' + client + ')...');
      try {
        const result = await tryDownload(url, null, { client, withCookies: true });
        if (result) {
          log('Cookies OK (' + client + '): ' + (fs.statSync(result.filePath).size / 1024).toFixed(1) + ' KB');
          return result;
        }
      } catch (err) {
        log('Cookies failed (' + client + '): ' + String(err.message || '').slice(0, 100));
      }
    }
  }

  // ── Stage 3: Proxy download ────────────────────────────────────────
  log('Finding proxy...');
  try {
    const proxy = await findWorkingProxy();
    if (proxy) {
      for (const client of clients) {
        log('Trying proxy (' + client + ')...');
        try {
          const result = await tryDownload(url, proxy, { client });
          if (result) {
            log('Proxy OK (' + client + '): ' + (fs.statSync(result.filePath).size / 1024).toFixed(1) + ' KB');
            return result;
          }
        } catch (err) {
          log('Proxy failed (' + client + '): ' + String(err.message || '').slice(0, 100));
        }
      }
    }
  } catch (err) {
    log('Proxy discovery failed: ' + err.message?.slice(0, 100));
  }

  // Invalidate stale proxy cache
  try { fs.unlinkSync(PROXY_CACHE); } catch {}

  throw new Error('Download failed. YouTube may be blocking this server IP. Try a different bot host.');
}

function removeDownloadedAudio(filePath) {
  if (!filePath) return;
  try {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(path.resolve(TEMP_DIR))) {
      return fs.promises.unlink(resolved).catch(() => {});
    }
  } catch {}
}

module.exports = { downloadAudio, removeDownloadedAudio };
