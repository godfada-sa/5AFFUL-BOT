const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const PROXY_CACHE = path.join(ROOT, '.safful-temp', '.working-proxy');
const MAX_SIZE = 50 * 1024 * 1024;

function findYtdlp() {
  const env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (env && fs.existsSync(env)) return env;
  const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const paths = [
    path.join(ROOT, '.safful-secrets', bin),
    path.join(ROOT, bin),
  ];
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  if (process.platform !== 'win32') {
    try {
      return require('child_process').execSync('which yt-dlp 2>/dev/null', { encoding: 'utf8' }).trim();
    } catch {}
  }
  return null;
}

function runYtdlp(args, timeout = 60000) {
  const bin = findYtdlp();
  if (!bin) return Promise.reject(new Error('yt-dlp not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || '').trim().slice(0, 500)));
        resolve(String(stdout || ''));
      });
  });
}

function guessMime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
           '.ogg': 'audio/ogg', '.webm': 'audio/webm' }[ext] || 'audio/mpeg';
}

// --- Proxy discovery ---

async function fetchProxies() {
  const sources = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  ];
  let proxies = [];
  for (const url of sources) {
    try {
      const res = await fetch(url, { timeout: 8000 });
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

async function findWorkingProxy() {
  // Try cached proxy first
  try {
    const cached = fs.readFileSync(PROXY_CACHE, 'utf8').trim();
    if (cached) {
      console.log('[proxy-dl] Testing cached proxy:', cached);
      try {
        await runYtdlp(['--proxy', cached, '--no-warnings', '--no-check-certificates',
          '--socket-timeout', '10', '--retries', '0', '--get-title',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 15000);
        console.log('[proxy-dl] Cached proxy works!');
        return cached;
      } catch { console.log('[proxy-dl] Cached proxy stale, searching...'); }
    }
  } catch {}

  const proxies = await fetchProxies();
  console.log('[proxy-dl] Testing', proxies.length, 'proxies...');

  for (let i = 0; i < proxies.length; i += 5) {
    const batch = proxies.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map(async (p) => {
      const url = p.includes('://') ? p : 'socks5://' + p;
      try {
        await runYtdlp(['--proxy', url, '--no-warnings', '--no-check-certificates',
          '--socket-timeout', '10', '--retries', '0', '--get-title',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], 18000);
        return url;
      } catch { return null; }
    }));
    const working = results.find(r => r.status === 'fulfilled' && r.value);
    if (working) {
      const proxy = working.value;
      console.log('[proxy-dl] Found working proxy:', proxy);
      fs.mkdirSync(path.dirname(PROXY_CACHE), { recursive: true });
      fs.writeFileSync(PROXY_CACHE, proxy, 'utf8');
      return proxy;
    }
  }
  return null;
}

// --- Download ---

async function downloadAudio(url) {
  const bin = findYtdlp();
  if (!bin) throw new Error('yt-dlp not found on this system');

  const proxy = await findWorkingProxy();
  if (!proxy) throw new Error('No working proxy found. YouTube may be fully blocking this region.');

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s');

  const args = [
    '--proxy', proxy,
    '--no-warnings', '--no-check-certificates', '--geo-bypass',
    '--no-playlist', '--socket-timeout', '20',
    '--retries', '2', '--max-filesize', String(MAX_SIZE),
    '-f', 'bestaudio/ba]/best',
    '--extractor-args', 'youtube:player_client=web_creator,web',
    '-o', outFile, url,
  ];

  console.log('[proxy-dl] Downloading via', proxy);
  const stdout = await runYtdlp(args, 90000);

  // Find the downloaded file
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const downloaded = lines.reverse().find(l => l && fs.existsSync(l));

  if (downloaded) {
    const stat = await fs.promises.stat(downloaded);
    if (stat.size > 0 && stat.size <= MAX_SIZE) {
      console.log('[proxy-dl] Downloaded:', (stat.size / 1024).toFixed(1) + 'KB');
      return { filePath: downloaded, mimeType: guessMime(downloaded) };
    }
  }

  // Scan temp dir for new files
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
    const best = candidates[0];
    console.log('[proxy-dl] Found file:', (best.stat.size / 1024).toFixed(1) + 'KB');
    return { filePath: best.fp, mimeType: guessMime(best.fp) };
  }

  // Proxy might be stale — delete cache and throw
  try { fs.unlinkSync(PROXY_CACHE); } catch {}
  throw new Error('Download produced no file. Proxy may be stale.');
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
