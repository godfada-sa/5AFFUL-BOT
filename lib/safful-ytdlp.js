const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');
const fetch = require('node-fetch');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'dl-cache');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const MAX_SIZE = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function log(msg) { process.stderr.write('[safful-dl] ' + msg + '\n'); }

function guessMime(fp) {
  const ext = path.extname(fp).toLowerCase();
  return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus',
           '.ogg': 'audio/ogg', '.webm': 'audio/webm' }[ext] || 'audio/mpeg';
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 1: Cobalt.tools API (free, no auth, pure HTTP)
// ═══════════════════════════════════════════════════════════════════════

const COBALT_INSTANCES = [
  'https://api.cobalt.tools',
  'https://cobalt-api.kwiatekmiki.com',
  'https://api-dl.cgmzz.net',
];

async function downloadViaCobalt(url) {
  for (const instance of COBALT_INSTANCES) {
    try {
      log('Trying cobalt: ' + instance);
      const res = await fetch(instance + '/', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url,
          audioFormat: 'best',
          isAudioOnly: true,
        }),
        timeout: 30000,
      });

      if (!res.ok) {
        log('Cobalt ' + instance + ' returned ' + res.status);
        continue;
      }

      const data = await res.json();

      if (data.status === 'error' || !data.url) {
        log('Cobalt error: ' + (data.error?.code || data.status || 'no url'));
        continue;
      }

      log('Cobalt got download URL, fetching audio...');
      return await downloadFromUrl(data.url, data.filename || null);
    } catch (err) {
      log('Cobalt ' + instance + ' failed: ' + String(err.message || '').slice(0, 100));
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 2: youtubei.js (already installed)
// ═══════════════════════════════════════════════════════════════════════

async function downloadViaYoutubei(url) {
  try {
    log('Trying youtubei.js...');
    const { Innertube } = require('youtubei.js');
    const yt = await Innertube.create();

    // Extract video ID from URL
    let videoId = null;
    const match = url.match(/(?:v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
    if (match) videoId = match[1];
    if (!videoId && /^[a-zA-Z0-9_-]{11}$/.test(url)) videoId = url;

    if (!videoId) {
      log('youtubei.js: could not extract video ID');
      return null;
    }

    const info = await yt.getBasicInfo(videoId);
    const title = info.basic_info.title || 'audio';
    log('youtubei.js: got info for "' + title + '"');

    // Try to get a direct URL from streaming data
    const streamingData = info.streaming_data;
    if (!streamingData) {
      log('youtubei.js: no streaming data');
      return null;
    }

    // Find best audio format
    const formats = [...(streamingData.adaptive_formats || []), ...(streamingData.formats || [])];
    const audioFormat = formats
      .filter(f => f.mime_type?.startsWith('audio/'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    if (!audioFormat) {
      log('youtubei.js: no audio format found');
      return null;
    }

    let audioUrl = audioFormat.decipher?.(yt.session.player) || audioFormat.url;
    if (!audioUrl) {
      log('youtubei.js: could not get direct URL (cipher required)');
      return null;
    }

    log('youtubei.js: got audio URL, downloading...');
    const ext = audioFormat.mime_type?.includes('webm') ? '.webm' : '.m4a';
    return await downloadFromUrl(audioUrl, title + ext);
  } catch (err) {
    log('youtubei.js failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 3: ytdl-secktor (@distube/ytdl-core)
// ═══════════════════════════════════════════════════════════════════════

async function downloadViaYtdl(url) {
  try {
    log('Trying ytdl-secktor...');
    const ytdl = require('ytdl-secktor');
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails?.title || 'audio';
    log('ytdl-secktor: got "' + title + '"');

    const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });

    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.webm');

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outFile);
      stream.pipe(ws);
      stream.on('error', reject);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    const stat = await fs.promises.stat(outFile);
    if (stat.size > 0 && stat.size <= MAX_SIZE) {
      return { filePath: outFile, mimeType: guessMime(outFile) };
    }
    await fs.promises.unlink(outFile).catch(() => {});
    return null;
  } catch (err) {
    log('ytdl-secktor failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Method 4: yt-dlp via child_process (only if available)
// ═══════════════════════════════════════════════════════════════════════

async function downloadViaYtdlp(url) {
  try {
    const { execFile } = require('child_process');

    // Find yt-dlp
    const env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
    let bin = env && fs.existsSync(env) ? env : null;

    if (!bin) {
      // Try common paths
      const ext = process.platform === 'win32' ? '.exe' : '';
      const candidates = [
        path.join(SECRETS_DIR, `yt-dlp${ext}`),
        path.join(ROOT, `yt-dlp${ext}`),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) { bin = p; break; }
      }
    }

    if (!bin) {
      // Try to find in PATH (may not work on Pterodactyl)
      try {
        bin = require('child_process').execSync('which yt-dlp 2>/dev/null || where yt-dlp 2>nul', { encoding: 'utf8' }).trim().split('\n')[0];
        if (!bin || !fs.existsSync(bin)) bin = null;
      } catch {}
    }

    if (!bin) {
      log('yt-dlp not found, skipping');
      return null;
    }

    log('yt-dlp found: ' + bin);
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
    const outFile = path.join(TEMP_DIR, randomUUID().slice(0, 8) + '.%(ext)s');

    const args = [
      '--no-warnings', '--no-check-certificates', '--geo-bypass', '--no-playlist',
      '--socket-timeout', '15', '--retries', '1', '--max-filesize', String(MAX_SIZE),
      '-f', 'bestaudio/ba]/best',
      '--extractor-args', 'youtube:player_client=tv_embedded',
      '-o', outFile, url,
    ];

    const stdout = await new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(String(stderr || err.message || '').slice(0, 300)));
          resolve(String(stdout || ''));
        });
    });

    const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const downloaded = lines.reverse().find(l => l && fs.existsSync(l));
    if (downloaded) {
      const stat = await fs.promises.stat(downloaded);
      if (stat.size > 0 && stat.size <= MAX_SIZE) {
        return { filePath: downloaded, mimeType: guessMime(downloaded) };
      }
    }
    return null;
  } catch (err) {
    log('yt-dlp failed: ' + String(err.message || '').slice(0, 150));
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Shared download helper
// ═══════════════════════════════════════════════════════════════════════

async function downloadFromUrl(url, filename) {
  log('Downloading audio from URL...');
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    timeout: 60000,
    redirect: 'follow',
  });

  if (!res.ok) throw new Error('Download HTTP ' + res.status);

  const contentType = res.headers.get('content-type') || '';
  let ext = '.webm';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) ext = '.mp3';
  else if (contentType.includes('mp4')) ext = '.m4a';
  else if (contentType.includes('ogg')) ext = '.ogg';
  else if (contentType.includes('opus')) ext = '.opus';

  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  const outFile = path.join(TEMP_DIR, (filename || randomUUID().slice(0, 8)) + ext);

  await pipeline(res.body, fs.createWriteStream(outFile));

  const stat = await fs.promises.stat(outFile);
  if (stat.size === 0 || stat.size > MAX_SIZE) {
    await fs.promises.unlink(outFile).catch(() => {});
    throw new Error('File size invalid: ' + stat.size);
  }

  log('Downloaded: ' + (stat.size / 1024).toFixed(1) + ' KB');
  return { filePath: outFile, mimeType: guessMime(outFile) };
}

// ═══════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════

async function downloadAudio(url) {
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  log('Starting download: ' + url);

  // Try each method in order
  const methods = [
    ['cobalt', downloadViaCobalt],
    ['youtubei', downloadViaYoutubei],
    ['ytdl', downloadViaYtdl],
    ['yt-dlp', downloadViaYtdlp],
  ];

  for (const [name, fn] of methods) {
    try {
      const result = await fn(url);
      if (result) {
        log('SUCCESS via ' + name + ': ' + (fs.statSync(result.filePath).size / 1024).toFixed(1) + ' KB');
        return result;
      }
    } catch (err) {
      log(name + ' error: ' + String(err.message || '').slice(0, 150));
    }
  }

  throw new Error('All download methods failed. YouTube may be blocking this server.');
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
