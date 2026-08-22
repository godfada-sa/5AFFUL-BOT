const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const MAX_AUDIO_SIZE = 50 * 1024 * 1024;  // 50 MB for audio
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB for video
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const LOG_FILE = path.join(ROOT, '.safful-temp', 'download.log');

// ── Loader.to API config ─────────────────────────────────────────────
const LOADER_DOMAINS = ['p.savenow.to', 'p.lbserver.xyz'];
const LOADER_KEY = 'dfcb6d76f2f6a9894gjkege8a4ab232222';

// Polling config — fast start, then back off
const POLL_INITIAL_MS = 1500;  // first poll after 1.5s
const POLL_MAX_MS = 3000;      // cap at 3s between polls
const POLL_BACKOFF = 1.3;      // multiply interval each time
const POLL_MAX_ATTEMPTS = 30;   // ~40s total budget

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  process.stderr.write('[safful-dl] ' + msg + '\n');
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
    '.ogg': 'audio/ogg', '.webm': 'audio/webm',
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
  };
  return map[ext] || (filePath.includes('video') ? 'video/mp4' : 'audio/mpeg');
}

// ═══════════════════════════════════════════════════════════════════════
//  Loader.to API — races both domains, supports audio + video
// ═══════════════════════════════════════════════════════════════════════

/**
 * Start a loader.to conversion job on a single domain.
 * @param {string} domain - e.g. 'p.savenow.to'
 * @param {string} url - YouTube URL
 * @param {string} format - 'mp3', 'mp4', '720', '1080', etc.
 * @returns {object|null} - { title, progress_url } or null
 */
async function startLoaderJob(domain, url, format = 'mp3') {
  const startUrl = `https://${domain}/api/v2/download?apikey=${LOADER_KEY}&url=${encodeURIComponent(url)}&format=${format}`;
  const res = await fetch(startUrl, {
    timeout: 20000,
    headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
  });
  const data = await res.json();
  if (data.success && data.progress_url) return data;
  return null;
}

/**
 * Download a file from a URL to disk. Returns file size.
 */
async function downloadFile(url, outFile, maxSize) {
  const res = await fetch(url, { timeout: 120000, headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  await pipeline(res.body, fs.createWriteStream(outFile));
  const stat = await fs.promises.stat(outFile);
  if (stat.size === 0 || stat.size > maxSize) {
    await fs.promises.unlink(outFile).catch(() => {});
    throw new Error('Invalid size: ' + stat.size);
  }
  return stat.size;
}

/**
 * Core loader.to download with fast adaptive polling.
 * @param {string} url - YouTube URL
 * @param {string} format - 'mp3' for audio, 'mp4' for video
 * @param {string} ext - file extension for output
 * @param {number} maxSize - max allowed file size
 */
async function downloadViaLoader(url, format = 'mp3', ext = '.mp3', maxSize = MAX_AUDIO_SIZE) {
  log('Trying loader.to API [' + format + '] (racing both domains)...');

  try {
    // Start jobs on both domains simultaneously
    const [job1, job2] = await Promise.all([
      startLoaderJob(LOADER_DOMAINS[0], url, format).catch(() => null),
      startLoaderJob(LOADER_DOMAINS[1], url, format).catch(() => null),
    ]);

    if (!job1 && !job2) {
      log('loader.to: both domains failed to start');
      return null;
    }

    const title = (job1 || job2)?.title || 'unknown';
    log('loader.to conversion started: ' + title);

    const jobs = [job1, job2].filter(Boolean);
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + ext);
    const pollStart = Date.now();
    let downloadUrl = null;
    let pollInterval = POLL_INITIAL_MS;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS && !downloadUrl; attempt++) {
      await new Promise(r => setTimeout(r, pollInterval));
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);

      const results = await Promise.all(jobs.map((job, idx) =>
        fetch(job.progress_url, { timeout: 8000, headers: { 'User-Agent': UA } })
          .then(r => r.json())
          .then(p => ({ idx, ...p }))
          .catch(() => ({ idx }))
      ));

      for (const r of results) {
        if (r.download_url) {
          downloadUrl = r.download_url;
          log('loader.to ready (' + elapsed + 's) from ' + LOADER_DOMAINS[r.idx]);
          break;
        }
        if (r.progress === -1 || r.error) {
          log('loader.to ' + LOADER_DOMAINS[r.idx] + ' error: ' + JSON.stringify(r).slice(0, 100));
        }
      }

      // Adaptive backoff: start fast, slow down as we wait
      pollInterval = Math.min(pollInterval * POLL_BACKOFF, POLL_MAX_MS);
    }

    if (!downloadUrl) {
      log('loader.to: no download URL after ' + POLL_MAX_ATTEMPTS + ' attempts');
      return null;
    }

    const size = await downloadFile(downloadUrl, outFile, maxSize);
    log('loader.to SUCCESS [' + format + ']: ' + (size / 1024).toFixed(1) + ' KB');
    return { filePath: outFile, mimeType: guessMime(outFile) };
  } catch (err) {
    log('loader.to failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  yt-dlp fallback (local binary, auto-downloaded)
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

function buildYtdlpArgs(url, format = 'audio') {
  const outTemplate = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s');
  const base = [
    '--no-warnings', '--no-check-certificates', '--geo-bypass', '--no-playlist',
    '--socket-timeout', '15', '--retries', '1', '--max-filesize', '100M',
    '-o', outTemplate, '--user-agent', UA,
  ];

  if (format === 'video') {
    return [...base, '-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best', '--merge-output-format', 'mp4', url];
  }
  return [...base, '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-f', 'bestaudio/best', url];
}

async function parseOutput(stdout, maxSize) {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const downloaded = lines.reverse().find(l => l && fs.existsSync(l));
  if (downloaded) {
    const stat = await fs.promises.stat(downloaded);
    if (stat.size > 0 && stat.size <= maxSize) {
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
        if (stat.size > 1024 && stat.size <= maxSize) candidates.push({ fp, stat });
      } catch {}
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (candidates.length > 0) return { filePath: candidates[0].fp, mimeType: guessMime(candidates[0].fp) };
  } catch {}
  return null;
}

async function downloadViaYtdlp(url, format = 'audio') {
  const bin = findYtdlp();
  if (!bin) throw new Error('yt-dlp not found');

  const maxSize = format === 'video' ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE;
  log('yt-dlp trying ' + format + ' download...');
  try {
    const stdout = await runYtdlp(buildYtdlpArgs(url, format), 60000);
    const result = await parseOutput(stdout, maxSize);
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
//  youtubei.js (last resort)
// ═══════════════════════════════════════════════════════════════════════

async function downloadViaYoutubei(url, format = 'audio') {
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

    let chosen;
    if (format === 'video') {
      const videos = (sd.adaptive_formats || []).filter(f => f.mime_type?.startsWith('video/mp4'));
      const audios = (sd.adaptive_formats || []).filter(f => f.mime_type?.startsWith('audio/'));
      const bestVideo = videos.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      const bestAudio = audios.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (bestVideo) {
        // For simplicity, just grab the best video-only stream
        // (youtubei.js doesn't easily merge; users can use yt-dlp for proper merging)
        chosen = bestVideo;
      }
    } else {
      chosen = [...(sd.adaptive_formats || []), ...(sd.formats || [])]
        .filter(f => f.mime_type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    }
    if (!chosen) return null;

    const mediaUrl = chosen.decipher ? chosen.decipher(yt.session.player) : chosen.url;
    if (!mediaUrl) return null;

    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const ext = chosen.mime_type?.includes('webm') ? '.webm' : (format === 'video' ? '.mp4' : '.m4a');
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + ext);
    const maxSize = format === 'video' ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE;
    const res = await fetch(mediaUrl, { headers: { 'User-Agent': UA }, timeout: 60000 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await pipeline(res.body, fs.createWriteStream(outFile));
    const stat = await fs.promises.stat(outFile);
    if (stat.size === 0 || stat.size > maxSize) {
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

/**
 * Download audio from YouTube URL.
 * Falls through: loader.to → yt-dlp → youtubei.js
 */
async function downloadAudio(url) {
  return downloadMedia(url, 'audio');
}

/**
 * Download video from YouTube URL.
 * Falls through: loader.to → yt-dlp → youtubei.js
 */
async function downloadVideo(url) {
  return downloadMedia(url, 'video');
}

/**
 * Unified download: 'audio' or 'video'.
 */
async function downloadMedia(url, type = 'audio') {
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  log('Starting ' + type + ' download: ' + url);

  const isVideo = type === 'video';
  const loaderFormat = isVideo ? '720' : 'mp3';  // loader.to uses numeric quality for video
  const loaderExt = isVideo ? '.mp4' : '.mp3';
  const maxSize = isVideo ? MAX_VIDEO_SIZE : MAX_AUDIO_SIZE;

  // Stage 1: loader.to API (races both domains)
  try {
    const result = await downloadViaLoader(url, loaderFormat, loaderExt, maxSize);
    if (result) return result;
  } catch (err) {
    log('loader.to stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 2: yt-dlp
  try {
    await ensureYtdlp();
    const result = await downloadViaYtdlp(url, type);
    if (result) return result;
  } catch (err) {
    log('yt-dlp stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 3: youtubei.js
  try {
    const result = await downloadViaYoutubei(url, type);
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

module.exports = { downloadAudio, downloadVideo, downloadMedia, removeDownloadedAudio };
