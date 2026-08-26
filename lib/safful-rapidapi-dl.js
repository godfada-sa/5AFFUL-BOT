/**
 * RapidAPI search module
 * Uses RapidAPI to SEARCH for YouTube videos (find URL by query).
 * Does NOT download from RapidAPI CDN (Google URLs are IP-bound,403 from different server).
 *
 * For actual download, use the existing pipeline: yt-dlp → loader.to → youtubei
 */
const fs = require('fs');
const path = require('path');

const RAPIDAPI_HOST = 'social-download-all-in-one.p.rapidapi.com';
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}/v1/social/autolink`;

// ── Key Pool ──
const _keyPool = [];
const _exhaustedKeys = new Set();
let _currentIndex = 0;
let _lastResetMonth = '';

(function initKeyPool() {
  const raw = process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '';
  if (raw) raw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => _keyPool.push(k));
})();

function _getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function _getNextKey() {
  if (_keyPool.length === 0) return null;
  for (let i = 0; i < _keyPool.length; i++) {
    const idx = (_currentIndex + i) % _keyPool.length;
    const key = _keyPool[idx];
    if (!_exhaustedKeys.has(key)) {
      _currentIndex = (idx + 1) % _keyPool.length;
      return key;
    }
  }
  return null;
}

function _markExhausted(key) {
  _exhaustedKeys.add(key);
  console.log(`[safful-dl] RapidAPI key ${key.slice(0, 10)}... EXHAUSTED (${_exhaustedKeys.size}/${_keyPool.length})`);
}

function _checkMonthlyReset() {
  if (_keyPool.length === 0) return;
  const currentMonth = _getCurrentMonth();
  if (_lastResetMonth !== currentMonth) {
    console.log(`[safful-dl] New month (${_lastResetMonth || 'first'} → ${currentMonth}) — resetting RapidAPI keys`);
    _exhaustedKeys.clear();
    _currentIndex = 0;
    _lastResetMonth = currentMonth;
  }
}

/**
 * Search via RapidAPI — lookup a URL and get video info
 * Returns { title, medias: [{url, type, quality, extension}] }
 * Does NOT download — the CDN URLs are IP-bound to RapidAPI's server.
 */
async function searchViaRapidAPI(url) {
  if (_keyPool.length === 0) throw new Error('No RapidAPI keys');
  _checkMonthlyReset();

  for (let attempt = 0; attempt < _keyPool.length; attempt++) {
    const key = _getNextKey();
    if (!key) throw new Error('All RapidAPI keys exhausted');

    try {
      console.log(`[safful-dl] RapidAPI searching key ${key.slice(0, 10)}...`);

      const res = await fetch(RAPIDAPI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Host': RAPIDAPI_HOST,
          'X-RapidAPI-Key': key,
        },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 429) {
        _markExhausted(key);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RapidAPI ${res.status}: ${text.substring(0, 200)}`);
      }

      const data = await res.json();
      if (data.error) throw new Error(data.message || 'RapidAPI error');
      if (!data.medias?.length) throw new Error('No medias found');

      console.log(`[safful-dl] RapidAPI found: ${data.title || 'unknown'} (${data.medias.length} options)`);
      return { title: data.title || '', medias: data.medias };
    } catch (e) {
      if (e.message?.includes('quota') || e.message?.includes('429')) {
        _markExhausted(key);
        continue;
      }
      throw e;
    }
  }

  throw new Error('All RapidAPI keys exhausted');
}

function log(msg) {
  process.stderr.write('[safful-dl] ' + msg + '\n');
}

/**
 * Search YouTube via RapidAPI (find the video URL), then use existing pipeline for download.
 * RapidAPI gives us the right YouTube URL in ~2s.
 */
async function searchYouTubeUrl(query) {
  if (_keyPool.length === 0) return null;
  try {
    // RapidAPI can resolve YouTube URLs but not search queries
    // For search queries, we need to construct a YouTube search URL
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const result = await searchViaRapidAPI(searchUrl);
    // The first video in the results is what we want
    const firstVideo = result.medias.find(m => m.type === 'video');
    if (firstVideo?.url) {
      // Extract YouTube video ID from the URL
      const match = firstVideo.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (match) return { url: `https://youtu.be/${match[1]}`, title: result.title };
    }
    return null;
  } catch (e) {
    log('RapidAPI search failed: ' + String(e.message || '').slice(0, 100));
    return null;
  }
}

function resetKeys() {
  _exhaustedKeys.clear();
  _currentIndex = 0;
  _lastResetMonth = '';
}

module.exports = {
  searchViaRapidAPI,
  searchYouTubeUrl,
  resetKeys,
  _keyPool,
  _exhaustedKeys,
};
