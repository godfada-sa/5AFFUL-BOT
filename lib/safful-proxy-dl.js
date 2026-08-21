const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'proxy-dl');
const MAX_SIZE = 50 * 1024 * 1024;

function findYtdlp() {
  const envPath = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  // Try multiple common locations
  const locations = [
    path.join(ROOT, '.safful-secrets', binary),
    path.join(TEMP_DIR, '..', binary),
    path.join(ROOT, 'node_modules', '.bin', binary),
    path.join(ROOT, binary),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }
  // Try to find via system PATH on Linux
  if (process.platform !== 'win32') {
    try {
      const { execSync } = require('child_process');
      const sysPath = execSync('which yt-dlp 2>/dev/null', { encoding: 'utf8' }).trim();
      if (sysPath && fs.existsSync(sysPath)) return sysPath;
    } catch {}
  }
  return null;
}

function findCookies() {
  const envCookies = String(process.env.SAFFUL_YT_COOKIES || '').trim();
  if (envCookies) {
    const abs = path.isAbsolute(envCookies) ? envCookies : path.join(ROOT, envCookies);
    if (fs.existsSync(abs)) return abs;
  }
  const defaultPath = path.join(ROOT, '.safful-secrets', 'youtube-cookies.txt');
  if (fs.existsSync(defaultPath)) return defaultPath;
  return null;
}

function runYtdlp(args, timeout = 30000) {
  const binary = findYtdlp();
  if (!binary) return Promise.reject(new Error('yt-dlp not found'));
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || '').trim().slice(0, 500)));
      resolve(String(stdout || ''));
    });
  });
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus', '.ogg': 'audio/ogg', '.webm': 'audio/webm' };
  return map[ext] || 'audio/mpeg';
}

/**
 * Fetch fresh working proxies from multiple sources and test them with yt-dlp
 */
async function findWorkingProxy(ytdlpPath, cookies) {
  const proxyApis = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'
  ];

  let proxies = [];
  for (const api of proxyApis) {
    try {
      const res = await fetch(api, { timeout: 8000 });
      if (!res.ok) continue;
      const text = await res.text();
      const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes(':'));
      proxies.push(...lines.slice(0, 15));
    } catch {}
  }

  // Deduplicate
  proxies = [...new Set(proxies)].slice(0, 30);
  console.log('[proxy-dl] Testing', proxies.length, 'proxies...');

  // Test proxies in parallel (5 at a time)
  for (let i = 0; i < proxies.length; i += 5) {
    const batch = proxies.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(async (proxy) => {
      const proxyUrl = proxy.includes('://') ? proxy : 'socks5://' + proxy;
      try {
        // Quick connectivity test first
        const testUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
        const args = ['--proxy', proxyUrl, '--no-warnings', '--no-check-certificates',
          '--socket-timeout', '12', '--retries', '0',
          '--get-title', testUrl];
        const result = await runYtdlp(args, 18000);
        if (result && result.trim().length > 0) {
          console.log('[proxy-dl] Proxy works! Title:', result.trim().slice(0, 50));
          return proxyUrl;
        }
      } catch {}
      return null;
    }));

    const working = results.find(r => r.status === 'fulfilled' && r.value);
    if (working) {
      console.log('[proxy-dl] Found working proxy:', working.value);
      // Cache the working proxy for next time
      try {
        const cacheFile = path.join(ROOT, '.safful-temp', '.last-proxy');
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.promises.writeFile(cacheFile, working.value, 'utf8');
      } catch {}
      return working.value;
    }
  }
  return null;
}

/**
 * Download audio using yt-dlp through a proxy
 */
async function downloadViaProxy(url, proxyUrl) {
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s');
  const args = [
    '--proxy', proxyUrl,
    '--no-warnings', '--no-check-certificates', '--geo-bypass',
    '--no-playlist', '--socket-timeout', '20',
    '--retries', '2', '--max-filesize', String(MAX_SIZE),
    '-f', 'bestaudio/ba]/bestaudio',
    '--postprocessor-args', 'ffmpeg:-vn',
    '-o', outFile, url
  ];
  const cookies = findCookies();
  if (cookies) args.splice(3, 0, '--cookies', cookies);

  const stdout = await runYtdlp(args, 60000);
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const downloaded = lines.reverse().find(l => l && fs.existsSync(l));

  if (!downloaded) {
    // Fallback: scan temp dir
    const files = await fs.promises.readdir(TEMP_DIR);
    const latest = files.sort().reverse()[0];
    if (latest) {
      const fp = path.join(TEMP_DIR, latest);
      const stat = await fs.promises.stat(fp);
      if (stat.size > 0 && stat.size <= MAX_SIZE) {
        return { filePath: fp, mimeType: guessMime(fp) };
      }
    }
    throw new Error('Proxy download produced no file');
  }

  const stat = await fs.promises.stat(downloaded);
  if (stat.size === 0 || stat.size > MAX_SIZE) {
    await fs.promises.unlink(downloaded).catch(() => {});
    throw new Error('Downloaded file too large or empty');
  }
  return { filePath: downloaded, mimeType: guessMime(downloaded) };
}

async function downloadAudio(url) {
  const ytdlpPath = findYtdlp();
  if (!ytdlpPath) throw new Error('yt-dlp not found');

  // Try cached proxy first
  let proxy = null;
  try {
    const cached = await fs.promises.readFile(path.join(ROOT, '.safful-temp', '.last-proxy'), 'utf8');
    if (cached && cached.trim()) {
      const cachedProxy = cached.trim();
      console.log('[proxy-dl] Trying cached proxy:', cachedProxy);
      try {
        const result = await runYtdlp(['--proxy', cachedProxy, '--no-warnings', '--no-check-certificates', '--socket-timeout', '10', '--get-title', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 15000);
        if (result && result.trim()) proxy = cachedProxy;
      } catch {}
    }
  } catch {}

  if (!proxy) {
    console.log('[proxy-dl] Searching for working proxy...');
    proxy = await findWorkingProxy(ytdlpPath, findCookies());
  }
  if (!proxy) throw new Error('No working proxy found');

  console.log('[proxy-dl] Downloading via proxy:', proxy);
  return await downloadViaProxy(url, proxy);
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
