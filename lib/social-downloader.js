/**
 * Unified social media downloader
 * Primary: RapidAPI social-download-all-in-one (supports IG, FB, TikTok, Twitter, YT)
 *   - Supports multiple API keys with automatic rotation on quota exhaustion
 *   - Env: RAPIDAPI_KEYS=key1,key2,key3 (comma-separated) OR RAPIDAPI_KEY=single_key
 * Fallback: yt-dlp with mediaconnect client
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RAPIDAPI_HOST = 'social-download-all-in-one.p.rapidapi.com';
const RAPIDAPI_URL = `https://${RAPIDAPI_HOST}/v1/social/autolink`;

// ── API Key Pool ────────────────────────────────────────────────────
// Supports multiple keys for quota rotation. When a key hits 429,
// it's marked exhausted and the next key is tried automatically.
const _keyPool = [];
const _exhaustedKeys = new Set();
let _currentIndex = 0;

// Parse keys from env: RAPIDAPI_KEYS=k1,k2,k3 OR RAPIDAPI_KEY=k1
(function initKeyPool() {
  const multi = process.env.RAPIDAPI_KEYS || '';
  const single = process.env.RAPIDAPI_KEY || '';
  const raw = multi || single;
  if (raw) {
    raw.split(',').map(k => k.trim()).filter(Boolean).forEach(k => _keyPool.push(k));
  }
})();

/** Get the next available key, or null if all exhausted */
function _getNextKey() {
  if (_keyPool.length === 0) return null;
  // Try all keys starting from current index
  for (let i = 0; i < _keyPool.length; i++) {
    const idx = (_currentIndex + i) % _keyPool.length;
    const key = _keyPool[idx];
    if (!_exhaustedKeys.has(key)) {
      _currentIndex = (idx + 1) % _keyPool.length; // advance for next call
      return key;
    }
  }
  return null; // all exhausted
}

/** Mark a key as exhausted (429 quota hit) */
function _markExhausted(key) {
  _exhaustedKeys.add(key);
  console.log(`[social-dl] RapidAPI key ${key.slice(0, 10)}... EXHAUSTED (${_exhaustedKeys.size}/${_keyPool.length} used)`);
}

/** Reset all keys (call monthly or on schedule) */
function resetKeys() {
  _exhaustedKeys.clear();
  _currentIndex = 0;
  _lastResetMonth = _getCurrentMonth();
  _saveResetState();
  console.log(`[social-dl] RapidAPI key pool reset — ${_keyPool.length} keys available`);
}

// ── Auto-Reset on New Month ─────────────────────────────────────────
// Persists reset state to disk so it survives restarts.
// Checks on every download — if month changed, auto-resets all keys.
const _resetStateFile = path.join(os.tmpdir(), 'safful-social', '.key-reset-state.json');
let _lastResetMonth = '';

function _getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function _loadResetState() {
  try {
    const data = JSON.parse(fs.readFileSync(_resetStateFile, 'utf8'));
    _lastResetMonth = data.month || '';
  } catch {
    _lastResetMonth = '';
  }
}

function _saveResetState() {
  try {
    ensureDir(path.dirname(_resetStateFile));
    fs.writeFileSync(_resetStateFile, JSON.stringify({ month: _lastResetMonth }));
  } catch {}
}

function _checkMonthlyReset() {
  if (_keyPool.length === 0) return;
  const currentMonth = _getCurrentMonth();
  if (_lastResetMonth !== currentMonth) {
    console.log(`[social-dl] New month detected (${_lastResetMonth || 'first run'} → ${currentMonth}) — resetting all RapidAPI keys`);
    _exhaustedKeys.clear();
    _currentIndex = 0;
    _lastResetMonth = currentMonth;
    _saveResetState();
    console.log(`[social-dl] RapidAPI key pool reset — ${_keyPool.length} keys available`);
  }
}

// Load persisted state on startup
_loadResetState();

const RAPIDAPI_KEY = _keyPool[0] || '';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getTempDir(prefix) {
  return ensureDir(path.join(os.tmpdir(), 'safful-social', prefix));
}

function cleanup(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

/**
 * Detect platform from URL
 */
function detectPlatform(url) {
  const u = String(url).toLowerCase();
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/facebook\.com|fb\.watch/.test(u)) return 'facebook';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/twitter\.com|x\.com/.test(u)) return 'twitter';
  if (/youtube|youtu\.be/.test(u)) return 'youtube';
  return 'unknown';
}

/**
 * Download via RapidAPI social-download-all-in-one
 * Returns: { success, title, author, thumbnail, medias: [{ url, quality, type, extension, data_size }] }
 */
async function downloadViaRapidAPI(sourceUrl) {
  if (_keyPool.length === 0) {
    throw new Error('No RapidAPI keys configured. Set RAPIDAPI_KEYS=k1,k2,k3 or RAPIDAPI_KEY=k1');
  }

  // Auto-reset exhausted keys if a new month has started
  _checkMonthlyReset();

  // Try up to all available keys
  let lastError = null;
  for (let attempt = 0; attempt < _keyPool.length; attempt++) {
    const key = _getNextKey();
    if (!key) {
      throw new Error('All RapidAPI keys exhausted');
    }

    try {
      const res = await fetch(RAPIDAPI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Host': RAPIDAPI_HOST,
          'X-RapidAPI-Key': key,
        },
        body: JSON.stringify({ url: sourceUrl }),
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429) {
        // Quota exceeded — mark this key and try next
        _markExhausted(key);
        lastError = new Error(`Key ${key.slice(0, 10)}... quota exceeded`);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`RapidAPI ${res.status}: ${text.substring(0, 200)}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(data.message || 'RapidAPI error');
      }

      return {
        success: true,
        title: data.title || '',
        author: data.author || '',
        thumbnail: data.thumbnail || '',
        medias: (data.medias || []).map(m => ({
          url: m.url,
          quality: m.quality || 'unknown',
          type: m.type || 'video',
          extension: m.extension || 'mp4',
          data_size: m.data_size || 0,
        })),
      };
    } catch (e) {
      lastError = e;
      // Only retry on 429 — re-throw other errors immediately
      throw e;
    }
  }

  throw lastError || new Error('All RapidAPI keys failed');
}

/**
 * Download via yt-dlp with various player clients
 * Returns: { success, filePath, isVideo }
 */
async function downloadViaYtdlp(sourceUrl, opts = {}) {
  const { audioOnly = false, outputDir, timeout = 30000 } = opts;
  const platform = detectPlatform(sourceUrl);
  const dir = outputDir || getTempDir(platform);
  const prefix = 'dl_' + Date.now();
  const outTemplate = path.join(dir, prefix + '.%(ext)s');

  const ytdlpPath = fs.existsSync('.safful-secrets/yt-dlp.exe') ? '.safful-secrets/yt-dlp.exe' : 'yt-dlp';
  const ffmpegDir = path.join('.safful-secrets');

  const args = [
    '--no-warnings', '--no-check-certificates', '--no-playlist',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  // Platform-specific extractor args
  if (platform === 'youtube') {
    args.push('--extractor-args', 'youtube:player_client=mediaconnect');
  } else if (platform === 'instagram') {
    // Try without special args first (web client is default)
  }

  if (audioOnly) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '128K');
  } else {
    // Force video selection — avoid picking audio-only streams
    if (platform === 'instagram') {
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best');
    } else if (platform === 'facebook') {
      args.push('-f', 'best[ext=mp4]/best');
    } else {
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best');
    }
    args.push('--merge-output-format', 'mp4');
  }

  if (fs.existsSync(ffmpegDir)) {
    args.push('--ffmpeg-location', ffmpegDir);
  }

  args.push('-o', outTemplate, '--no-playlist', sourceUrl);

  return new Promise((resolve) => {
    execFile(ytdlpPath, args, { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, error: (stderr || err.message || '').slice(0, 500) });
        return;
      }

      // Find the downloaded file
      const lines = stdout.trim().split('\n').filter(Boolean);
      let filePath = lines[lines.length - 1];

      if (!filePath || !fs.existsSync(filePath)) {
        // Search temp dir for new files
        try {
          const files = fs.readdirSync(dir)
            .filter(f => f.startsWith(prefix))
            .sort();
          if (files.length > 0) {
            filePath = path.join(dir, files[files.length - 1]);
          }
        } catch {}
      }

      if (filePath && fs.existsSync(filePath)) {
        const ext = path.extname(filePath).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.mkv'].includes(ext);
        resolve({ success: true, filePath, isVideo });
      } else {
        resolve({ success: false, error: 'No output file found' });
      }
    });
  });
}

/**
 * High-level download function
 * Tries RapidAPI first, then yt-dlp fallback
 *
 * @param {string} sourceUrl - The social media URL
 * @param {object} opts - { audioOnly: bool, caption: string }
 * @returns {object} - { success, buffer, filename, caption, method }
 */
async function download(sourceUrl, opts = {}) {
  const { audioOnly = false, caption: customCaption } = opts;
  const platform = detectPlatform(sourceUrl);

  // Stage 1: RapidAPI (fast, works from any IP via their servers)
  try {
    console.log(`[social-dl] Trying RapidAPI (${platform})...`);
    const apiResult = await downloadViaRapidAPI(sourceUrl);

    if (apiResult.success && apiResult.medias.length > 0) {
      // Pick the best media
      let media;
      if (audioOnly) {
        // Prefer audio-only, then any mp3, then smallest video
        media = apiResult.medias.find(m => m.type === 'audio') ||
                apiResult.medias.find(m => m.extension === 'mp3') ||
                apiResult.medias.find(m => m.type === 'video');
      } else {
        // For IG/FB: NEVER pick audio — prefer video, then photo/image
        if (platform === 'instagram' || platform === 'facebook') {
          media = apiResult.medias.find(m => m.type === 'video' && m.extension !== 'mp3') ||
                  apiResult.medias.find(m => m.type === 'photo') ||
                  apiResult.medias.find(m => m.type === 'image') ||
                  apiResult.medias.find(m => m.type === 'video');
        } else {
          media = apiResult.medias.find(m => m.type === 'video') || apiResult.medias[0];
        }
      }

      if (media && media.url) {
        console.log(`[social-dl] RapidAPI: downloading ${media.quality}/${media.extension}...`);
        const downloadRes = await fetch(media.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://social-download-all-in-one.p.rapidapi.com/',
            'Origin': 'https://social-download-all-in-one.p.rapidapi.com',
          },
          signal: AbortSignal.timeout(60000),
        });

        if (downloadRes.ok) {
          const buf = Buffer.from(await downloadRes.arrayBuffer());
          if (buf.length > 1000) { // Sanity check — at least 1KB
            const ext = audioOnly ? 'mp3' : (media.extension || 'mp4');
            const filename = `${platform}_${Date.now()}.${ext}`;
            const caption = customCaption || `*${platform.charAt(0).toUpperCase() + platform.slice(1)} Download*\n${apiResult.title ? '📝 ' + apiResult.title.slice(0, 80) : ''}${apiResult.author ? '\n👤 ' + apiResult.author : ''}`;

            console.log(`[social-dl] RapidAPI SUCCESS: ${(buf.length / 1024).toFixed(1)}KB via rapidapi`);
            return { success: true, buffer: buf, filename, caption, method: 'rapidapi' };
          }
        }
      }
    }
    console.log('[social-dl] RapidAPI: no usable media found');
  } catch (e) {
    console.log(`[social-dl] RapidAPI failed: ${e.message}`);
  }

  // Stage 2: yt-dlp fallback (uses YOUR server IP)
  try {
    console.log(`[social-dl] Trying yt-dlp (${platform}, audio=${audioOnly})...`);
    const ytdlpResult = await downloadViaYtdlp(sourceUrl, { audioOnly });

    if (ytdlpResult.success && ytdlpResult.filePath) {
      const buf = fs.readFileSync(ytdlpResult.filePath);
      const ext = path.extname(ytdlpResult.filePath).replace('.', '');
      const filename = `${platform}_${Date.now()}.${ext}`;
      const caption = customCaption || `*${platform.charAt(0).toUpperCase() + platform.slice(1)} Download*\nyt-dlp`;

      cleanup(ytdlpResult.filePath);
      console.log(`[social-dl] yt-dlp SUCCESS: ${(buf.length / 1024).toFixed(1)}KB via ytdlp`);
      return { success: true, buffer: buf, filename, caption, method: 'ytdlp' };
    }
    console.log(`[social-dl] yt-dlp failed: ${ytdlpResult.error || 'unknown'}`);
  } catch (e) {
    console.log(`[social-dl] yt-dlp failed: ${e.message}`);
  }

  return { success: false, error: 'All download methods failed' };
}

module.exports = {
  download,
  downloadViaRapidAPI,
  downloadViaYtdlp,
  detectPlatform,
  cleanup,
  resetKeys,
  RAPIDAPI_KEY,
};
