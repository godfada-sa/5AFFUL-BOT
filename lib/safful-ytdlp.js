const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const MAX_SIZE = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const LOG_FILE = path.join(ROOT, '.safful-temp', 'download.log');

// Loader.to API config — race both domains
const LOADER_DOMAINS = ['p.savenow.to', 'p.lbserver.xyz'];
const LOADER_KEY = 'dfcb6d76f2f6a9894gjkege8a4ab232222';

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  process.stderr.write('[safful-dl] ' + msg + '\n');
  try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function guessMime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
           '.ogg': 'audio/ogg', '.webm': 'audio/webm' }[ext] || 'audio/mpeg';
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 1: loader.to API (PRIMARY — downloads on their servers)
// ═══════════════════════════════════════════════════════════════════════

async function startLoaderJob(domain, url) {
  const startUrl = `https://${domain}/api/v2/download?apikey=${LOADER_KEY}&url=${encodeURIComponent(url)}&format=mp3`;
  const res = await fetch(startUrl, {
    timeout: 30000,
    headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
  });
  const data = await res.json();
  if (data.success && data.progress_url) return data;
  return null;
}

async function pollForDownload(progressUrl, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(progressUrl, { timeout: 8000, headers: { 'User-Agent': UA } });
      const prog = await res.json();
      if (prog.download_url) return prog;
      if (prog.progress === -1 || prog.error) return null;
    } catch {}
  }
  return null;
}

async function downloadFile(url, outFile) {
  const res = await fetch(url, { timeout: 120000, headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  await pipeline(res.body, fs.createWriteStream(outFile));
  const stat = await fs.promises.stat(outFile);
  if (stat.size === 0 || stat.size > MAX_SIZE) {
    await fs.promises.unlink(outFile).catch(() => {});
    throw new Error('Invalid size: ' + stat.size);
  }
  return stat.size;
}

async function downloadViaLoader(url) {
  log('Trying loader.to API (racing both domains)...');

  try {
    // Start jobs on both domains simultaneously
    const [job1, job2] = await Promise.all([
      startLoaderJob(LOADER_DOMAINS[0], url).catch(() => null),
      startLoaderJob(LOADER_DOMAINS[1], url).catch(() => null),
    ]);

    if (!job1 && !job2) {
      log('loader.to: both domains failed to start');
      return null;
    }

    const title = (job1 || job2)?.title || 'unknown';
    log('loader.to conversion started: ' + title);

    // Poll both jobs simultaneously and take the first download URL
    const jobs = [job1, job2].filter(Boolean);
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.mp3');
    const pollStart = Date.now();
    let downloadUrl = null;

    for (let i = 0; i < 20 && !downloadUrl; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);

      const results = await Promise.all(jobs.map((job, idx) =>
        fetch(job.progress_url, { timeout: 8000, headers: { 'User-Agent': UA } })
          .then(r => r.json())
          .then(p => ({ idx, ...p }))
          .catch(() => ({ idx }))
      ));

      for (const r of results) {
        if (r.download_url) {
          downloadUrl = r.download_url;
          log('loader.to download ready (' + elapsed + 's) from ' + LOADER_DOMAINS[r.idx]);
          break;
        }
        if (r.progress === -1 || r.error) {
          log('loader.to ' + LOADER_DOMAINS[r.idx] + ' error: ' + JSON.stringify(r).slice(0, 100));
        }
      }
    }

    if (!downloadUrl) {
      log('loader.to: no download URL received');
      return null;
    }

    // Download the file
    const size = await downloadFile(downloadUrl, outFile);
    log('loader.to SUCCESS: ' + (size / 1024).toFixed(1) + ' KB');
    return { filePath: outFile, mimeType: 'audio/mpeg' };
  } catch (err) {
    log('loader.to failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 2: yt-dlp (local binary, auto-downloaded)
// ═══════════════════════════════════════════════════════════════════════

let _ytDlpPath = null;
let _downloading = null;

function findYtdlp() {
  if (_ytDlpPath && fs.existsSync(_ytDlpPath)) return _ytDlpPath;

  const env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (env && fs.existsSync(env)) { _ytDlpPath = env; return env; }

  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(SECRETS_DIR, `yt-dlp${ext}`),
    path.join(ROOT, `yt-dlp${ext}`),
    path.join(ROOT, '.safful-secrets', `yt-dlp${ext}`),
  ];

  try {
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    const result = require('child_process').execSync(cmd + ' 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (result && fs.existsSync(result)) candidates.unshift(result);
  } catch {}

  for (const p of candidates) {
    try { if (fs.existsSync(p)) { _ytDlpPath = p; return p; } } catch {}
  }
  return null;
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

    const res = await fetch(getDownloadUrl(), { timeout: 90000, redirect: 'follow' });
    log('Download response: ' + res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status);

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
  })().catch(err => { _downloading = null; log('yt-dlp download FAILED: ' + err.message); throw err; });

  return _downloading;
}

function runYtdlp(args, timeout = 30000) {
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

function buildYtdlpArgs(url) {
  return [
    '--no-warnings', '--no-check-certificates', '--geo-bypass', '--no-playlist',
    '--socket-timeout', '15', '--retries', '1', '--max-filesize', String(MAX_SIZE),
    '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '-f', 'bestaudio/best',
    '-o', path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s'),
    '--user-agent', UA,
    url,
  ];
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
      try { const stat = await fs.promises.stat(fp); if (stat.size > 1024 && stat.size <= MAX_SIZE) candidates.push({ fp, stat }); } catch {}
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (candidates.length > 0) return { filePath: candidates[0].fp, mimeType: guessMime(candidates[0].fp) };
  } catch {}
  return null;
}

async function downloadViaYtdlp(url) {
  const bin = findYtdlp();
  if (!bin) throw new Error('yt-dlp not found');

  log('yt-dlp trying direct download...');
  try {
    const stdout = await runYtdlp(buildYtdlpArgs(url), 30000);
    const result = await parseOutput(stdout);
    if (result) {
      log('yt-dlp SUCCESS: ' + (fs.statSync(result.filePath).size / 1024).toFixed(1) + ' KB');
      return result;
    }
  } catch (err) {
    const msg = String(err.message || '').slice(0, 120);
    log('yt-dlp failed: ' + msg);
    if (/Video unavailable|Private video|removed|age-restricted/i.test(msg)) throw err;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 3: youtubei.js (last resort)
// ═══════════════════════════════════════════════════════════════════════

async function downloadViaYoutubei(url) {
  try {
    const { Innertube } = require('youtubei.js');
    const yt = await Innertube.create();
    let videoId = null;
    const match = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
    if (!videoId && /^[a-zA-Z0-9_-]{11}$/.test(url)) videoId = url;
    if (!videoId) return null;

    const info = await yt.getBasicInfo(videoId);
    log('youtubei: got "' + (info.basic_info.title || 'unknown') + '"');
    const sd = info.streaming_data;
    if (!sd) return null;

    const audio = [...(sd.adaptive_formats || []), ...(sd.formats || [])]
      .filter(f => f.mime_type?.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (!audio) return null;

    const audioUrl = audio.decipher ? audio.decipher(yt.session.player) : audio.url;
    if (!audioUrl) return null;

    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + (audio.mime_type?.includes('webm') ? '.webm' : '.m4a'));
    const res = await fetch(audioUrl, { headers: { 'User-Agent': UA }, timeout: 60000 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await pipeline(res.body, fs.createWriteStream(outFile));
    const stat = await fs.promises.stat(outFile);
    if (stat.size === 0 || stat.size > MAX_SIZE) {
      await fs.promises.unlink(outFile).catch(() => {});
      return null;
    }
    return { filePath: outFile, mimeType: guessMime(outFile) };
  } catch (err) {
    log('youtubei failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════

async function downloadAudio(url) {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  log('Starting download: ' + url);

  // Stage 1: loader.to API (races both domains)
  try {
    const result = await downloadViaLoader(url);
    if (result) return result;
  } catch (err) {
    log('loader.to stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 2: yt-dlp
  try {
    await ensureYtdlp();
    const result = await downloadViaYtdlp(url);
    if (result) return result;
  } catch (err) {
    log('yt-dlp stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 3: youtubei.js
  try {
    const result = await downloadViaYoutubei(url);
    if (result) return result;
  } catch (err) {
    log('youtubei stage failed: ' + String(err.message || '').slice(0, 150));
  }

  throw new Error('Download failed. Check .safful-temp/download.log for details.');
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
