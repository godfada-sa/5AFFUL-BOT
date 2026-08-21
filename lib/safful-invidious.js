/**
 * safful-invidious.js — Invidious/Piped fallback for YouTube audio downloads.
 *
 * When yt-dlp fails (IP blocked by YouTube), this module downloads audio
 * through public Invidious or Piped instances instead.
 *
 * Exports the same interface as safful-ytdlp: downloadAudio(url) → {filePath, mimeType}
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { randomUUID } = require('crypto');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'safful-songs');
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

// --- Instance lists (rotate on failure) ---

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.jing.rocks',
  'https://vid.puffyan.us',
  'https://invidious.snopyta.org',
  'https://yewtu.be',
  'https://inv.tux.pizza',
  'https://invidious.privacyredirect.com',
  'https://iv.ggtyler.dev',
];

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://piped-api.lunar.icu',
  'https://api.piped.projectsegfau.lt',
];

// --- Helpers ---

function extractVideoId(url) {
  if (!url) return null;
  // Direct ID
  if (/^[A-Za-z0-9_-]{11}$/.test(url.trim())) return url.trim();
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0];
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    // /shorts/ or /embed/ or /v/
    const m = u.pathname.match(/\/(shorts|embed|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  } catch {}
  return null;
}

function getMimeForExt(ext) {
  const map = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.opus': 'audio/opus',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
  };
  return map[ext] || 'audio/mp4';
}

function getExtForMime(mime) {
  if (!mime) return '.m4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('opus')) return '.opus';
  return '.m4a';
}

// --- Invidious download ---

async function tryInvidious(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const apiUrl = `${instance}/api/v1/videos/${videoId}`;
      const res = await fetch(apiUrl, { timeout: 10000 });
      if (!res.ok) continue;
      const data = await res.json();

      // Pick the best audio-only adaptive format
      const audioStreams = (data.adaptiveFormats || []).filter(
        (f) => f.type && f.type.startsWith('audio/') && f.url
      );
      if (!audioStreams.length) continue;

      // Sort by bitrate descending, pick highest
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = audioStreams[0];

      const ext = getExtForMime(best.type);
      const id = randomUUID().slice(0, 8);
      const filePath = path.join(TEMP_DIR, `${id}${ext}`);

      const dlRes = await fetch(best.url, { timeout: 60000 });
      if (!dlRes.ok) continue;

      // Check content-length
      const contentLen = parseInt(dlRes.headers.get('content-length') || '0', 10);
      if (contentLen > MAX_SIZE) continue;

      await fs.promises.mkdir(TEMP_DIR, { recursive: true });
      const ws = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        dlRes.body.pipe(ws);
        dlRes.body.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      // Verify file exists and isn't empty/too large
      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0 || stat.size > MAX_SIZE) {
        await fs.promises.unlink(filePath).catch(() => {});
        continue;
      }

      return { filePath, mimeType: best.type || getMimeForExt(ext) };
    } catch {
      continue;
    }
  }
  return null;
}

// --- Piped download ---

async function tryPiped(videoId) {
  for (const instance of PIPED_INSTANCES) {
    try {
      const apiUrl = `${instance}/streams/${videoId}`;
      const res = await fetch(apiUrl, { timeout: 10000 });
      if (!res.ok) continue;
      const data = await res.json();

      const audioStreams = (data.audioStreams || []).filter(
        (s) => s.url && s.mimeType
      );
      if (!audioStreams.length) continue;

      // Pick highest bitrate
      audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const best = audioStreams[0];

      const ext = getExtForMime(best.mimeType);
      const id = randomUUID().slice(0, 8);
      const filePath = path.join(TEMP_DIR, `${id}${ext}`);

      const dlRes = await fetch(best.url, { timeout: 60000 });
      if (!dlRes.ok) continue;

      const contentLen = parseInt(dlRes.headers.get('content-length') || '0', 10);
      if (contentLen > MAX_SIZE) continue;

      await fs.promises.mkdir(TEMP_DIR, { recursive: true });
      const ws = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        dlRes.body.pipe(ws);
        dlRes.body.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0 || stat.size > MAX_SIZE) {
        await fs.promises.unlink(filePath).catch(() => {});
        continue;
      }

      return { filePath, mimeType: best.mimeType || getMimeForExt(ext) };
    } catch {
      continue;
    }
  }
  return null;
}

// --- Public interface ---

async function downloadAudio(urlOrQuery) {
  const videoId = extractVideoId(urlOrQuery);
  if (!videoId) throw new Error('Could not extract a YouTube video ID from the input.');

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });

  // Try Invidious first
  const invResult = await tryInvidious(videoId);
  if (invResult) {
    console.log('[Invidious] Downloaded via Invidious:', videoId);
    return invResult;
  }

  // Try Piped
  const pipedResult = await tryPiped(videoId);
  if (pipedResult) {
    console.log('[Piped] Downloaded via Piped:', videoId);
    return pipedResult;
  }

  throw new Error('All Invidious/Piped instances failed for this video.');
}

async function removeDownloadedAudio(filePath) {
  if (!filePath) return;
  try {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(path.resolve(TEMP_DIR))) {
      await fs.promises.unlink(resolved).catch(() => {});
    }
  } catch {}
}

module.exports = { downloadAudio, removeDownloadedAudio };
