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
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const YTDLP_DL_TIMEOUT = 60000;

// ═══════════════════════════════════════════════════════════════════════
//  yt-dlp finder + auto-download
// ═══════════════════════════════════════════════════════════════════════

let _ytDlpPath = null;
let _downloading = null; // singleton download promise

function findYtdlp() {
  if (_ytDlpPath && fs.existsSync(_ytDlpPath)) return _ytDlpPath;

  // 1) Explicit env override
  const env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (env && fs.existsSync(env)) { _ytDlpPath = env; return env; }

  // 2) System PATH + common local paths
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

  // Deduplicate concurrent downloads
  if (_downloading) return _downloading;

  _downloading = (async () => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const dest = path.join(SECRETS_DIR, `yt-dlp${ext}`);

    console.log('[safful-ytdlp] yt-dlp not found, downloading from GitHub...');
    await fs.promises.mkdir(SECRETS_DIR, { recursive: true });

    const url = getDownloadUrl();
    const res = await fetch(url, { timeout: YTDLP_DL_TIMEOUT, redirect: 'follow' });
    if (!res.ok) throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);

    const tmpDest = dest + '.tmp';
    await pipeline(res.body, fs.createWriteStream(tmpDest));

    // Atomic rename
    await fs.promises.rename(tmpDest, dest);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      await fs.promises.chmod(dest, 0o755);
    }

    const stat = await fs.promises.stat(dest);
    console.log('[safful-ytdlp] Downloaded yt-dlp:', (stat.size / 1024 / 1024).toFixed(1), 'MB');

    _ytDlpPath = dest;
    return dest;
  })().catch(err => {
    _downloading = null;
    throw err;
  });

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
  if (!fs.existsSync(cookiePath)) { console.warn('[safful-ytdlp] Cookies not found:', cookiePath); return null; }
  return cookiePath;
}

function buildArgs(url, proxy, opts = {}) {
  const args = [
    '--no-warnings', '--no-check-certificates', '--geo-bypass', '--no-playlist',
    '--socket-timeout', '20', '--retries', '2', '--max-filesize', String(MAX_SIZE),
    '-f', 'bestaudio/ba]/best',
    '--extractor-args', 'youtube:player_client=tv_embedded',
    '-o', path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s'),
  ];
  if (proxy) args.push('--proxy', proxy);
  // Only add cookies if explicitly requested (stale cookies can break things)
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
  // Scan temp dir
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
    if (candidates.length > 0) {
      return { filePath: candidates[0].fp, mimeType: guessMime(candidates[0].fp) };
    }
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
      '--socket-timeout', '10', '--retries', '0', '--get-title',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 15000);
    return url;
  } catch { return null; }
}

async function findWorkingProxy() {
  // Try cached proxy
  try {
    const cached = fs.readFileSync(PROXY_CACHE, 'utf8').trim();
    if (cached) {
      console.log('[safful-ytdlp] Testing cached proxy:', cached);
      const result = await testProxy(cached);
      if (result) { console.log('[safful-ytdlp] Cached proxy OK'); return result; }
      console.log('[safful-ytdlp] Cached proxy stale, searching...');
      try { fs.unlinkSync(PROXY_CACHE); } catch {}
    }
  } catch {}

  const proxies = await fetchProxies();
  console.log('[safful-ytdlp] Testing', proxies.length, 'proxies...');

  // Test in batches of 5
  for (let i = 0; i < proxies.length; i += 5) {
    const batch = proxies.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(p => testProxy(p)));
    const working = results.find(r => r.status === 'fulfilled' && r.value);
    if (working) {
      const proxy = working.value;
      console.log('[safful-ytdlp] Found working proxy:', proxy);
      try { fs.mkdirSync(path.dirname(PROXY_CACHE), { recursive: true }); fs.writeFileSync(PROXY_CACHE, proxy, 'utf8'); } catch {}
      return proxy;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════

async function downloadAudio(url) {
  // Auto-download yt-dlp if not found anywhere
  await ensureYtdlp();
  const bin = findYtdlp();
  if (!bin) throw new Error('yt-dlp not found and auto-download failed.');

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });

  // ── Attempt 1: Direct download (no proxy, no cookies) ─────────────
  console.log('[safful-ytdlp] Trying direct download...');
  try {
    const stdout = await runYtdlp(buildArgs(url, null), 120000);
    const result = await parseOutput(stdout);
    if (result) {
      console.log('[safful-ytdlp] Direct download OK:', (fs.statSync(result.filePath).size / 1024).toFixed(1), 'KB');
      return result;
    }
  } catch (err) {
    const msg = String(err.message || '');
    console.log('[safful-ytdlp] Direct failed:', msg.slice(0, 150));
    if (/unavailable|Private video|removed|age-restricted|not available/i.test(msg)) throw err;
  }

  // ── Attempt 2: Direct with cookies (if configured) ─────────────────
  if (getConfiguredCookies()) {
    console.log('[safful-ytdlp] Trying with cookies...');
    try {
      const stdout = await runYtdlp(buildArgs(url, null, { withCookies: true }), 120000);
      const result = await parseOutput(stdout);
      if (result) {
        console.log('[safful-ytdlp] Cookies download OK:', (fs.statSync(result.filePath).size / 1024).toFixed(1), 'KB');
        return result;
      }
    } catch (err) {
      console.log('[safful-ytdlp] Cookies failed:', String(err.message || '').slice(0, 150));
    }
  }

  // ── Attempt 3: Download via SOCKS5 proxy ───────────────────────────
  console.log('[safful-ytdlp] Falling back to proxy...');
  try {
    const proxy = await findWorkingProxy();
    if (!proxy) {
      throw new Error('No working proxy found and direct download failed.');
    }

    console.log('[safful-ytdlp] Downloading via proxy:', proxy);
    const stdout = await runYtdlp(buildArgs(url, proxy), 120000);
    const result = await parseOutput(stdout);
    if (result) {
      console.log('[safful-ytdlp] Proxy download OK:', (fs.statSync(result.filePath).size / 1024).toFixed(1), 'KB');
      return result;
    }
  } catch (err) {
    try { fs.unlinkSync(PROXY_CACHE); } catch {}
    console.error('[safful-ytdlp] Proxy download also failed:', err.message?.slice(0, 200));
  }

  // ── Attempt 4: Proxy with cookies ──────────────────────────────────
  if (getConfiguredCookies()) {
    console.log('[safful-ytdlp] Trying proxy with cookies...');
    try {
      const proxy = fs.existsSync(PROXY_CACHE) ? fs.readFileSync(PROXY_CACHE, 'utf8').trim() : null;
      if (proxy) {
        const stdout = await runYtdlp(buildArgs(url, proxy, { withCookies: true }), 120000);
        const result = await parseOutput(stdout);
        if (result) {
          console.log('[safful-ytdlp] Proxy+cookies OK:', (fs.statSync(result.filePath).size / 1024).toFixed(1), 'KB');
          return result;
        }
      }
    } catch (err) {
      console.error('[safful-ytdlp] Proxy+cookies failed:', err.message?.slice(0, 200));
    }
  }

  throw new Error('Download produced no file. YouTube may be blocking this server.');
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
