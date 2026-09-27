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

// ── Keepvid API (embedded Node.js module) ───────────────────────────
const { getLinks: keepvidGetLinks } = require('./keepvid-api');

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

// Loader.to's legacy compatibility API is asynchronous: request a conversion,
// poll until it is ready, then download the returned CDN URL. Keepvid remains
// the next fallback so a loader outage cannot stop every .song request.
async function downloadViaLoader(url, type = 'audio', maxSize = MAX_AUDIO_SIZE) {
  const format = type === 'video' ? '720' : 'mp3';
  const hosts = ['https://loader.to'];
  log('Trying loader.to API (' + format + ')...');

  for (const host of hosts) {
    try {
      const requestUrl = host + '/ajax/download.php?start=1&end=1&format=' + encodeURIComponent(format) + '&url=' + encodeURIComponent(url);
      const start = await fetch(requestUrl, {
        timeout: 30000,
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': host + '/' },
      });
      if (!start.ok) throw new Error('start HTTP ' + start.status);
      const job = await start.json();
      if (!job || !job.id) throw new Error('no conversion job returned');

      let downloadUrl = '';
      for (let attempt = 0; attempt < 36; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const progress = await fetch(host + '/ajax/progress.php?id=' + encodeURIComponent(job.id), {
          timeout: 20000,
          headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': host + '/' },
        });
        if (!progress.ok) throw new Error('progress HTTP ' + progress.status);
        const state = await progress.json();
        const candidate = state && (state.download_url || state.downloadUrl || state.url || state.download);
        if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
          downloadUrl = candidate;
          break;
        }
        if (state && /error|failed/i.test(String(state.text || state.status || ''))) {
          throw new Error(String(state.text || state.status));
        }
      }
      if (!downloadUrl) throw new Error('conversion timed out');

      const extension = type === 'video' ? '.mp4' : '.mp3';
      const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + extension);
      const size = await downloadFile(downloadUrl, outFile, maxSize);
      log('loader.to SUCCESS: ' + (size / 1024).toFixed(1) + ' KB');
      return { filePath: outFile, mimeType: guessMime(outFile) };
    } catch (err) {
      log('loader.to failed: ' + String(err.message || err).slice(0, 150));
    }
  }
  return null;
}

/**
 * Download via keepvid API — gets direct CDN URLs without polling.
 * @param {string} url - YouTube URL
 * @param {string} type - 'audio' or 'video'
 * @param {number} maxSize - max allowed file size
 */
async function downloadViaKeepvid(url, type = 'audio', maxSize = MAX_AUDIO_SIZE) {
  log('Trying keepvid API (' + type + ')...');

  try {
    const data = await keepvidGetLinks(url);

    if (!data.links || data.links.length === 0) {
      log('keepvid API: no links returned');
      return null;
    }

    log('keepvid API: got ' + data.links.length + ' links for "' + (data.title || 'unknown') + '"');

    // Pick the best link based on type
    let best = null;
    if (type === 'audio') {
      best = data.links
        .filter(l => l.url && l.url.includes('googlevideo.com/videoplayback'))
        .filter(l => l.ext === 'm4a' || l.ext === 'opus' || l.ext === 'webm')
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
      if (!best) {
        best = data.links
          .filter(l => l.url && l.url.includes('googlevideo.com/videoplayback'))
          .filter(l => !l.quality.includes('video'))
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
      }
    } else {
      best = data.links
        .filter(l => l.url && l.url.includes('googlevideo.com/videoplayback'))
        .filter(l => l.ext === 'mp4')
        .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
    }

    if (!best || !best.url) {
      log('keepvid API: no suitable ' + type + ' link found');
      return null;
    }

    log('keepvid API: selected ' + best.format + ' ' + best.quality + ' (' + (best.filesizeMb || '?') + 'MB)');

    const ext = best.ext || (type === 'audio' ? '.webm' : '.mp4');
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.' + ext);
    const size = await downloadFile(best.url, outFile, maxSize);
    log('keepvid API SUCCESS: ' + (size / 1024).toFixed(1) + ' KB');
    return { filePath: outFile, mimeType: guessMime(outFile) };
  } catch (err) {
    log('keepvid API failed: ' + String(err.message || '').slice(0, 150));
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

  // Use cookies if available (helps bypass bot detection for age-restricted content)
  const cookiesFile = path.join(SECRETS_DIR, 'youtube-cookies.txt');
  try { if (fs.existsSync(cookiesFile)) base.push('--cookies', cookiesFile); } catch {}

  if (format === 'video') {
    return [...base, '-f', 'bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/best', '--merge-output-format', 'mp4', url];
  }
  // Audio: try mp3 conversion if ffmpeg available, otherwise download best audio as-is
  const hasFfmpeg = findFfmpeg();
  if (hasFfmpeg) {
    return [...base, '--ffmpeg-location', path.dirname(hasFfmpeg), '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-f', 'bestaudio/best', url];
  }
  // No ffmpeg — download best audio directly (m4a/webm/opus)
  return [...base, '-f', 'bestaudio/best', url];
}

function findFfmpeg() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(SECRETS_DIR, `ffmpeg${ext}`),
    path.join(ROOT, `ffmpeg${ext}`),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return require('child_process').execSync(cmd + ' 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function runFfmpeg(ffmpegPath, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: timeout || 30000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || 'ffmpeg error').trim().slice(0, 300)));
        resolve(String(stdout || ''));
      });
  });
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
      const ffmpegBin = findFfmpeg();

      // If audio and not mp3, convert with ffmpeg if available
      if (format === 'audio' && !result.filePath.endsWith('.mp3') && ffmpegBin) {
        const mp3Path = result.filePath.replace(/\.[^.]+$/, '.mp3');
        try {
          log('yt-dlp: converting to mp3 via ffmpeg...');
          await runFfmpeg(ffmpegBin, [
            '-y', '-i', result.filePath,
            '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k',
            '-f', 'mp3', mp3Path
          ], 30000);
          fs.promises.unlink(result.filePath).catch(() => {});
          result.filePath = mp3Path;
          result.mimeType = 'audio/mpeg';
          log('yt-dlp: converted to mp3');
        } catch (convErr) {
          log('yt-dlp: mp3 conversion failed, keeping original: ' + convErr.message?.slice(0, 80));
        }
      }

      // If video and not mp4, convert with ffmpeg if available
      if (format === 'video' && !result.filePath.endsWith('.mp4') && ffmpegBin) {
        const mp4Path = result.filePath.replace(/\.[^.]+$/, '.mp4');
        try {
          log('yt-dlp: converting to mp4 via ffmpeg...');
          await runFfmpeg(ffmpegBin, [
            '-y', '-i', result.filePath,
            '-c:v', 'libx264', '-c:a', 'aac',
            '-movflags', '+faststart',
            mp4Path
          ], 60000);
          fs.promises.unlink(result.filePath).catch(() => {});
          result.filePath = mp4Path;
          result.mimeType = 'video/mp4';
          log('yt-dlp: converted to mp4');
        } catch (convErr) {
          log('yt-dlp: mp4 conversion failed, keeping original: ' + convErr.message?.slice(0, 80));
        }
      }
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

  // Stage 1: yt-dlp (fastest — local binary, no polling)
  try {
    await ensureYtdlp();
    const result = await downloadViaYtdlp(url, type);
    if (result) return result;
  } catch (err) {
    log('yt-dlp stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 2: loader.to conversion API
  try {
    const result = await downloadViaLoader(url, type, maxSize);
    if (result) return result;
  } catch (err) {
    log('loader.to stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 3: keepvid API (direct CDN URLs, no polling)
  try {
    const result = await downloadViaKeepvid(url, type, maxSize);
    if (result) return result;
  } catch (err) {
    log('keepvid API stage failed: ' + String(err.message || '').slice(0, 150));
  }

  // Stage 4: youtubei.js (last resort)
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
