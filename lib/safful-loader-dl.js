/**
 * Clean downloader — loader.to + youtubei.js only. No yt-dlp.
 *
 * Pipeline:
 *   1. loader.to (their servers convert + host, ~15-20s)
 *   2. youtubei.js (direct YouTube, last resort)
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const MAX_AUDIO_SIZE = 50 * 1024 * 1024;  // 50 MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const LOADER_DOMAINS = ['p.savenow.to', 'p.lbserver.xyz'];
const LOADER_KEY = 'dfcb6d76f2f6a9894gjkege8a4ab232222';
const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 1500;
const POLL_BACKOFF = 1.2;
const POLL_MAX_ATTEMPTS = 40;

function log(msg) {
  process.stderr.write('[safful-dl] ' + msg + '\n');
  try {
    const logFile = path.join(ROOT, '.safful-temp', 'download.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg',
    '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
  };
  return map[ext] || (filePath.includes('video') ? 'video/mp4' : 'audio/mpeg');
}

// ── loader.to ──────────────────────────────────────────────────────────

async function startLoaderJob(domain, url, format) {
  const apiUrl = `https://${domain}/api/v2/download?apikey=${LOADER_KEY}&url=${encodeURIComponent(url)}&format=${format}`;
  const res = await fetch(apiUrl, {
    timeout: 20000,
    headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
  });
  const data = await res.json();
  if (data.success && data.progress_url) return data;
  return null;
}

async function downloadFile(url, filePath, maxSize) {
  const res = await fetch(url, {
    timeout: 120000,
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await pipeline(res.body, fs.createWriteStream(filePath));

  const stat = await fs.promises.stat(filePath);
  if (stat.size === 0 || stat.size > maxSize) {
    await fs.promises.unlink(filePath).catch(() => {});
    throw new Error('Invalid size: ' + stat.size);
  }
  return stat.size;
}

async function downloadViaLoader(url, type) {
  const format = type === 'audio' ? 'mp3' : '720';
  const maxSize = type === 'audio' ? MAX_AUDIO_SIZE : MAX_VIDEO_SIZE;

  log(`Trying loader.to API [${format}] (racing both domains)...`);

  const [job1, job2] = await Promise.all([
    startLoaderJob(LOADER_DOMAINS[0], url, format).catch(() => null),
    startLoaderJob(LOADER_DOMAINS[1], url, format).catch(() => null),
  ]);

  if (!job1 && !job2) {
    log('loader.to: both domains failed to start');
    return null;
  }

  const selected = job1 || job2;
  const domainIdx = job1 ? 0 : 1;
  log(`loader.to conversion started: ${selected.title || 'unknown'}`);

  const jobs = [job1, job2].filter(Boolean);
  const filePath = path.join(TEMP_DIR, randomUUID().slice(0, 8) + (type === 'audio' ? '.mp3' : '.mp4'));

  // Poll for download URL
  let downloadUrl = null;
  let pollDelay = POLL_INITIAL_MS;
  const startTime = Date.now();

  for (let i = 0; i < POLL_MAX_ATTEMPTS && !downloadUrl; i++) {
    await new Promise(r => setTimeout(r, pollDelay));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const results = await Promise.all(jobs.map((j, idx) =>
      fetch(j.progress_url, { timeout: 5000, headers: { 'User-Agent': UA } })
        .then(r => r.json())
        .then(d => ({ idx, ...d }))
        .catch(() => ({ idx }))
    ));

    for (const r of results) {
      if (r.download_url) {
        downloadUrl = r.download_url;
        log(`loader.to ready (${elapsed}s) from ${LOADER_DOMAINS[r.idx]}`);
        break;
      }
      if (r.progress === -1 || r.error) {
        log(`loader.to error from ${LOADER_DOMAINS[r.idx]}: ${r.error || 'progress=-1'}`);
      }
    }

    pollDelay = Math.min(pollDelay * POLL_BACKOFF, POLL_MAX_MS);
  }

  if (!downloadUrl) {
    log(`loader.to: no download URL after ${POLL_MAX_ATTEMPTS} attempts`);
    return null;
  }

  // Download the file
  const size = await downloadFile(downloadUrl, filePath, maxSize);
  log(`loader.to SUCCESS [${format}]: ${(size / 1024).toFixed(0)} KB`);

  // For audio: try to re-encode to mp3 128kbps with ffmpeg
  if (type === 'audio') {
    const ffmpegPath = findFfmpeg();
    if (ffmpegPath) {
      const mp3Path = filePath.replace(/\.mp3$/, '_128.mp3');
      try {
        log('loader.to: re-encoding to 128kbps...');
        const { execFile } = require('child_process');
        await new Promise((resolve, reject) => {
          execFile(ffmpegPath, [
            '-y', '-i', filePath,
            '-codec:a', 'libmp3lame', '-b:a', '128K',
            '-ac', '2', mp3Path,
          ], { timeout: 30000, windowsHide: true }, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
        const mp3Stat = await fs.promises.stat(mp3Path);
        const origStat = await fs.promises.stat(filePath);
        log(`loader.to: re-encoded ${(origStat.size / 1024).toFixed(0)} KB → ${(mp3Stat.size / 1024).toFixed(0)} KB`);
        await fs.promises.unlink(filePath).catch(() => {});
        await fs.promises.rename(mp3Path, filePath);
      } catch (e) {
        log('loader.to: re-encode failed, keeping original: ' + (e.message || '').slice(0, 60));
        await fs.promises.unlink(mp3Path).catch(() => {});
      }
    } else {
      log('loader.to: ffmpeg not found, skipping re-encode');
    }
  }

  return { filePath, mimeType: guessMime(filePath) };
}

// ── ffmpeg finder ──────────────────────────────────────────────────────

function findFfmpeg() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    path.join(SECRETS_DIR, 'ffmpeg' + ext),
    path.join(ROOT, 'ffmpeg' + ext),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  try {
    const { execSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

// ── youtubei.js fallback ───────────────────────────────────────────────

async function downloadViaYoutubei(url, type) {
  try {
    const { Innertube } = require('youtubei.js');
    const yt = await Innertube.create();

    // Extract video ID
    const match = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    const videoId = match ? match[1] : (/^[a-zA-Z0-9_-]{11}$/.test(url) ? url : null);
    if (!videoId) return null;

    const info = await yt.getBasicInfo(videoId);
    log('youtubei: got "' + (info.basic_info.title || 'unknown') + '"');

    const streaming = info.streaming_data;
    if (!streaming) return null;

    let format;
    if (type === 'audio') {
      const audios = [...streaming.adaptive_formats || [], ...streaming.formats || []]
        .filter(f => f.mime_type?.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      format = audios[0];
    } else {
      const videos = (streaming.formats || [])
        .filter(f => f.mime_type?.includes('video/mp4'))
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      format = videos[0];
    }

    if (!format) return null;

    const dlUrl = format.decipher ? format.decipher(yt.session.player) : format.url;
    if (!dlUrl) return null;

    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const ext = type === 'audio' ? '.m4a' : '.mp4';
    const filePath = path.join(TEMP_DIR, randomUUID().slice(0, 8) + ext);
    const maxSize = type === 'audio' ? MAX_AUDIO_SIZE : MAX_VIDEO_SIZE;

    const res = await fetch(dlUrl, { headers: { 'User-Agent': UA }, timeout: 60000 });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    await pipeline(res.body, fs.createWriteStream(filePath));
    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0 || stat.size > maxSize) {
      await fs.promises.unlink(filePath).catch(() => {});
      return null;
    }

    return { filePath, mimeType: guessMime(filePath) };
  } catch (e) {
    log('youtubei failed: ' + (e.message || '').slice(0, 100));
    return null;
  }
}

// ── Main download function ─────────────────────────────────────────────

async function downloadMedia(url, type) {
  try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch {}
  log(`Starting ${type} download: ${url}`);

  // Stage 1: loader.to (~15-20s)
  try {
    const result = await downloadViaLoader(url, type);
    if (result) return result;
  } catch (e) {
    log('loader.to stage failed: ' + String(e.message || '').slice(0, 100));
  }

  // Stage 2: youtubei.js (last resort)
  try {
    const result = await downloadViaYoutubei(url, type);
    if (result) return result;
  } catch (e) {
    log('youtubei stage failed: ' + (e.message || '').slice(0, 100));
  }

  throw new Error('All download methods failed. Check .safful-temp/download.log for details.');
}

async function downloadAudio(url) {
  return downloadMedia(url, 'audio');
}

async function downloadVideo(url) {
  return downloadMedia(url, 'video');
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
