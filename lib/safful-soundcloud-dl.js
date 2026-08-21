const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = path.join(ROOT, '.safful-temp', 'sc-downloads');
const MAX_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Search SoundCloud for a track and download the best match as audio.
 * Uses SoundCloud's public search (no API key needed for basic search).
 */
async function searchAndDownload(query) {
  await fs.promises.mkdir(TEMP_DIR, { recursive: true });

  // Strategy 1: Use SoundCloud search via their resolve endpoint
  console.log('[SoundCloud] Searching for:', query);
  
  let tracks;
  try {
    tracks = await searchSoundCloud(query);
  } catch (e) {
    console.log('[SoundCloud] Search failed:', e.message);
    throw new Error('SoundCloud search failed: ' + e.message);
  }

  if (!tracks || !tracks.length) {
    throw new Error('No results found on SoundCloud for: ' + query);
  }

  // Pick the best result (most plays or shortest duration to avoid mixes)
  const track = tracks[0];
  console.log('[SoundCloud] Found:', track.title, 'by', track.artist);
  console.log('[SoundCloud] Duration:', track.duration, 'ms');

  // Try to get a download/stream URL
  let audioUrl;
  try {
    audioUrl = track.streamUrl || track.downloadUrl;
    if (!audioUrl) {
      // Try resolve endpoint for the stream URL
      audioUrl = await resolveStreamUrl(track.permalinkUrl || track.url);
    }
  } catch (e) {
    console.log('[SoundCloud] Could not get stream URL:', e.message);
  }

  if (!audioUrl) {
    // Last resort: try the direct URL pattern
    audioUrl = track.url;
  }

  // Download the audio
  const ext = '.mp3';
  const filePath = path.join(TEMP_DIR, randomUUID().slice(0, 8) + ext);
  
  try {
    const res = await fetch(audioUrl, {
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    });
    
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    
    const contentType = res.headers.get('content-type') || '';
    console.log('[SoundCloud] Downloading... content-type:', contentType);
    
    const fileStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
      res.body.pipe(fileStream);
      res.body.on('error', reject);
      fileStream.on('finish', resolve);
    });

    const stat = await fs.promises.stat(filePath);
    if (stat.size === 0 || stat.size > MAX_SIZE) {
      await fs.promises.unlink(filePath).catch(() => {});
      throw new Error('Invalid file size: ' + stat.size);
    }

    console.log('[SoundCloud] Downloaded:', (stat.size / 1024).toFixed(1) + 'KB');
    return { filePath, mimeType: 'audio/mpeg' };
  } catch (e) {
    await fs.promises.unlink(filePath).catch(() => {});
    throw e;
  }
}

/**
 * Search SoundCloud using their public suggest/search API
 */
async function searchSoundCloud(query) {
  // SoundCloud has a public search that doesn't need auth
  const searchUrl = 'https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(query) + '&limit=5&linked_partitioning=1';
  
  const res = await fetch(searchUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    // Fallback: use the HTML search and parse
    return await searchSoundCloudFallback(query);
  }

  const data = await res.json();
  const collection = data.collection || [];
  
  return collection.slice(0, 5).map(track => ({
    title: track.title || 'Unknown',
    artist: (track.user && track.user.username) || 'Unknown',
    duration: track.duration || 0,
    url: track.permalink_url || '',
    permalinkUrl: track.permalink_url || '',
    streamUrl: track.media && track.media.transcoding && track.media.transcoding.url || '',
    downloadUrl: track.download_url || ''
  }));
}

/**
 * Fallback: resolve a SoundCloud track URL to get a stream URL
 */
async function resolveStreamUrl(permalinkUrl) {
  const resolveUrl = 'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent(permalinkUrl) + '&client_id=iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX';
  
  const res = await fetch(resolveUrl, { timeout: 10000 });
  if (!res.ok) return null;
  
  const data = await res.json();
  if (data.media && data.media.transcoding && data.media.transcoding.url) {
    return data.media.transcoding.url;
  }
  return null;
}

/**
 * Fallback search using SoundCloud's HTML page
 */
async function searchSoundCloudFallback(query) {
  const searchUrl = 'https://soundcloud.com/search?q=' + encodeURIComponent(query);
  
  const res = await fetch(searchUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  if (!res.ok) return [];
  
  const html = await res.text();
  
  // Extract track URLs from the HTML
  const trackMatches = html.match(/href="https:\/\/soundcloud\.com\/[^"]+\/[^"]+"/g) || [];
  const tracks = [];
  
  for (const match of trackMatches.slice(0, 5)) {
    const url = match.replace('href="', '').replace('"', '');
    const parts = url.split('/').filter(Boolean);
    if (parts.length >= 2) {
      tracks.push({
        title: parts[parts.length - 1].replace(/-/g, ' '),
        artist: parts[parts.length - 2].replace(/-/g, ' '),
        duration: 0,
        url: url,
        permalinkUrl: url,
        streamUrl: '',
        downloadUrl: ''
      });
    }
  }
  
  return tracks;
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

module.exports = { searchAndDownload, removeDownloadedAudio };
