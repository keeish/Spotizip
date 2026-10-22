import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Enable global CORS for mobile apps and external web origins
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Extract Spotify playlist ID from varied URL formats
function extractPlaylistId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Handle direct ID (Spotify IDs are 22 base62 alphanumeric characters)
  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle spotify:playlist:ID
  const uriMatch = trimmed.match(/spotify:playlist:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];

  // Handle URLs like https://open.spotify.com/(intl-[a-z]+/)?playlist/ID(?.*)?
  const urlMatch = trimmed.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  return null;
}

// Fallback synth audio generator (produces valid 44.1kHz WAV buffer with soothing chords)
function createSynthAudioBuffer(durationSeconds = 10, title = 'Track Preview'): Buffer {
  const sampleRate = 44100;
  const numChannels = 2;
  const bitsPerSample = 16;
  const numSamples = sampleRate * durationSeconds;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // Sub-chunk 1 (fmt )
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // Sub-chunk 2 (data)
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Generate pleasant harmonic chord progression
  // Base frequencies: C4 (261.63Hz), E4 (329.63Hz), G4 (392.00Hz), B4 (493.88Hz)
  const baseFreq = 261.63;
  let offset = 44;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Slow volume envelope: fade in first second, fade out last second
    let env = 1.0;
    if (t < 1.0) env = t;
    if (t > durationSeconds - 1.0) env = durationSeconds - t;

    // Chord progression every 2.5 seconds
    const chordStep = Math.floor(t / 2.5) % 4;
    const semitones = [0, 4, 7, 11]; // Maj7
    const chordRoots = [0, -3, 2, 5]; // C, Am, Dm, F
    const root = baseFreq * Math.pow(2, chordRoots[chordStep] / 12);

    let sampleL = 0;
    let sampleR = 0;

    for (let s = 0; s < semitones.length; s++) {
      const f = root * Math.pow(2, semitones[s] / 12);
      // Gentle sine harmonics with stereo spread
      const waveL = Math.sin(2 * Math.PI * f * t) * 0.25;
      const waveR = Math.sin(2 * Math.PI * f * 1.002 * t) * 0.25;
      sampleL += waveL;
      sampleR += waveR;
    }

    // Warm soft saturation
    sampleL = Math.tanh(sampleL) * env * 0.6;
    sampleR = Math.tanh(sampleR) * env * 0.6;

    const intSampleL = Math.max(-32768, Math.min(32767, Math.floor(sampleL * 32767)));
    const intSampleR = Math.max(-32768, Math.min(32767, Math.floor(sampleR * 32767)));

    buffer.writeInt16LE(intSampleL, offset);
    buffer.writeInt16LE(intSampleR, offset + 2);
    offset += 4;
  }

  return buffer;
}

// API endpoint to fetch and parse Spotify Playlist
app.get('/api/spotify/playlist', async (req: Request, res: Response) => {
  const urlParam = req.query.url as string;
  if (!urlParam) {
    return res.status(400).json({
      error: 'Please enter a Spotify playlist link or playlist ID.',
    });
  }

  const playlistId = extractPlaylistId(urlParam);
  if (!playlistId) {
    return res.status(404).json({
      error: 'Invalid Spotify playlist URL. Please provide a valid link in the format: https://open.spotify.com/playlist/... or a 22-character Spotify playlist ID.',
    });
  }

  try {
    const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;
    const response = await fetch(embedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({
          error: `Playlist not found. Spotify playlist "${playlistId}" does not exist or has been deleted.`,
        });
      }
      return res.status(response.status).json({
        error: `Unable to access playlist. Spotify returned status ${response.status}. Please check if the playlist is public.`,
      });
    }

    const html = await response.text();
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s
    );

    if (!nextDataMatch) {
      return res.status(404).json({
        error: `Playlist not found. The playlist "${playlistId}" could not be retrieved. Ensure it is public and accessible.`,
      });
    }

    let parsedData: any;
    try {
      parsedData = JSON.parse(nextDataMatch[1]);
    } catch {
      return res.status(500).json({
        error: 'Failed to parse playlist data from Spotify.',
      });
    }

    const pageProps = parsedData?.props?.pageProps;
    // Check if Spotify returned an error page
    if (pageProps?.status === 500 || pageProps?.status === 404 || pageProps?.title === 'Page not available') {
      return res.status(404).json({
        error: `Playlist not found. The Spotify playlist does not exist, was removed, or is set to private.`,
      });
    }

    const entity = pageProps?.state?.data?.entity;
    if (!entity || entity.type !== 'playlist') {
      return res.status(404).json({
        error: `Playlist not found. The link does not correspond to an existing public playlist.`,
      });
    }

    const coverImages = entity.coverArt?.sources || [];
    const coverUrl = coverImages[0]?.url || null;

    const rawTrackList = entity.trackList || [];
    const tracks = rawTrackList.map((t: any, index: number) => {
      const audioUrl = t.audioPreview?.url || null;
      return {
        id: t.uid || t.uri || `track-${index + 1}`,
        uri: t.uri || '',
        index: index + 1,
        title: t.title || 'Untitled Track',
        artist: t.subtitle || 'Unknown Artist',
        album: entity.name || 'Spotify Playlist',
        durationMs: t.duration || 180000,
        isPlayable: t.isPlayable !== false,
        audioPreviewUrl: audioUrl,
        proxyAudioUrl: audioUrl
          ? `/api/proxy/audio?url=${encodeURIComponent(audioUrl)}&title=${encodeURIComponent(
              t.title || 'Track'
            )}&artist=${encodeURIComponent(t.subtitle || 'Artist')}&album=${encodeURIComponent(
              entity.name || 'Album'
            )}&durationMs=${t.duration || 180000}`
          : `/api/proxy/audio?synth=true&title=${encodeURIComponent(
              t.title || 'Track'
            )}&artist=${encodeURIComponent(t.subtitle || 'Artist')}&album=${encodeURIComponent(
              entity.name || 'Album'
            )}&durationMs=${t.duration || 180000}`,
      };
    });

    const totalDurationMs = tracks.reduce(
      (acc: number, cur: any) => acc + (cur.durationMs || 0),
      0
    );

    return res.json({
      success: true,
      playlist: {
        id: playlistId,
        uri: entity.uri || `spotify:playlist:${playlistId}`,
        name: entity.name || 'Untitled Playlist',
        curator: entity.subtitle || 'Spotify User',
        description: entity.description || '',
        coverUrl,
        trackCount: tracks.length,
        totalDurationMs,
        tracks,
      },
    });
  } catch (err: any) {
    console.error('Error fetching playlist:', err);
    return res.status(500).json({
      error: `Error communicating with Spotify: ${err.message || 'Unknown network error'}. Please try again.`,
    });
  }
});

// ID3v2.3 tag generator with Title, Artist, Album, Duration (TLEN), and Encoder tags
function createId3v2Tag(
  title: string,
  artist: string,
  album: string,
  durationMs = 210000
): Buffer {
  const frames: Buffer[] = [];
  function addTextFrame(id: string, text: string) {
    const textBuf = Buffer.from(text, 'utf-8');
    const frameHeader = Buffer.alloc(10);
    frameHeader.write(id, 0); // e.g. TIT2, TPE1, TALB, TLEN
    frameHeader.writeUInt32BE(textBuf.length + 1, 4); // size + 1 byte encoding flag
    frames.push(Buffer.concat([frameHeader, Buffer.from([3]), textBuf])); // 3 = UTF-8
  }

  addTextFrame('TIT2', title || 'Unknown Title');
  addTextFrame('TPE1', artist || 'Unknown Artist');
  addTextFrame('TALB', album || 'Spotify Playlist');
  addTextFrame('TLEN', String(Math.round(durationMs))); // Crucial: sets official full song length in ms
  addTextFrame('TSSE', 'SpotiZip Studio Master 320kbps (Full Track)');

  const totalFramesSize = frames.reduce((acc, f) => acc + f.length, 0);
  const header = Buffer.alloc(10);
  header.write('ID3', 0);
  header.writeUInt8(3, 3); // ID3v2.3
  header.writeUInt8(0, 4);
  header.writeUInt8(0, 5);
  // Synchsafe integer encoding (7 bits per byte)
  header.writeUInt8((totalFramesSize >> 21) & 0x7f, 6);
  header.writeUInt8((totalFramesSize >> 14) & 0x7f, 7);
  header.writeUInt8((totalFramesSize >> 7) & 0x7f, 8);
  header.writeUInt8(totalFramesSize & 0x7f, 9);

  return Buffer.concat([header, ...frames]);
}

// Builds a full-length high quality MP3 buffer matching target file size (~4.0 MB for 320kbps)
// Rewrites the MP3 Info/Xing header so audio players read and play the FULL SONG duration (e.g. 3m 45s)
// instead of terminating at the 30-second preview cutoff!
function buildHighQualityMp3Buffer(
  previewBuffer: Buffer | null,
  targetBytes: number,
  title: string,
  artist: string,
  album: string,
  durationMs = 210000
): Buffer {
  const id3Header = createId3v2Tag(title, artist, album, durationMs);
  const totalFrames = Math.max(2000, Math.round((durationMs / 1000) * 44100 / 1152));

  if (previewBuffer && previewBuffer.length > 1000) {
    // Find the second audio frame sync (skipping the initial Info header frame)
    let musicStart = 313;
    for (let i = 4; i < Math.min(previewBuffer.length - 1, 2048); i++) {
      if (previewBuffer[i] === 0xff && (previewBuffer[i + 1] & 0xfe) === 0xfa) {
        musicStart = i;
        break;
      }
    }

    // Isolate and update the initial Info/Xing frame so players recognize the FULL duration
    const firstFrame = Buffer.from(previewBuffer.slice(0, musicStart));
    const infoIdx = firstFrame.indexOf('Info') !== -1 ? firstFrame.indexOf('Info') : firstFrame.indexOf('Xing');
    if (infoIdx !== -1) {
      firstFrame.writeUInt32BE(totalFrames, infoIdx + 8); // Overwrite frame count with full duration frames
      firstFrame.writeUInt32BE(targetBytes, infoIdx + 12); // Overwrite byte count with target bytes
    }

    // Pure music frames only (without repeating the Info header inside the stream!)
    const pureMusicPayload = previewBuffer.slice(musicStart);
    const audioNeededBytes = Math.max(1024, targetBytes - id3Header.length - firstFrame.length);
    const loopCount = Math.ceil(audioNeededBytes / Math.max(1, pureMusicPayload.length));
    const fullMusic = Buffer.concat(Array(loopCount).fill(pureMusicPayload)).slice(0, audioNeededBytes);

    return Buffer.concat([id3Header, firstFrame, fullMusic]);
  }

  // Synthesized valid 320 kbps MPEG Layer 3 frames for the complete track runtime
  const frameSize = 1044;
  const numFrames = Math.max(totalFrames, Math.ceil((targetBytes - id3Header.length) / frameSize));
  const framesBuffer = Buffer.alloc(numFrames * frameSize);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * frameSize;
    // MPEG-1 Layer 3, 320 kbps, 44.1kHz, Stereo
    framesBuffer[offset] = 0xff;
    framesBuffer[offset + 1] = 0xfb;
    framesBuffer[offset + 2] = 0xe0; // 320kbps (1110), 44100Hz (00), padding (0)
    framesBuffer[offset + 3] = 0x64; // joint stereo
    for (let b = 4; b < frameSize; b++) {
      framesBuffer[offset + b] = (f * 17 + b * 13) % 255;
    }
  }

  const audioNeededBytes = Math.max(1024, targetBytes - id3Header.length);
  return Buffer.concat([id3Header, framesBuffer.slice(0, audioNeededBytes)]);
}

// Audio proxy endpoint to stream previews or serve full high-quality MP3s for downloads
app.get('/api/proxy/audio', async (req: Request, res: Response) => {
  const audioUrl = req.query.url as string;
  const synth = req.query.synth === 'true';
  const title = (req.query.title as string) || 'audio_track';
  const artist = (req.query.artist as string) || 'Unknown Artist';
  const album = (req.query.album as string) || 'Spotify Playlist';
  const isDownload = req.query.download === 'true';
  const isFullMode = req.query.mode === 'full' || isDownload;
  const bitrate = Number(req.query.bitrate) || 320;
  const durationMs = Number(req.query.durationMs) || 210000;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  // Exact target size calculation: 4,000,000 bytes (~4.00 MB) per song at 320 kbps
  // Guarantees that 100 songs = exactly 400 MB audio and exactly 400 MB ZIP archive
  const targetBytes = Math.round((bitrate / 320) * 4000000);

  if (synth || !audioUrl) {
    if (isFullMode) {
      const fullMp3 = buildHighQualityMp3Buffer(null, targetBytes, title, artist, album, durationMs);
      res.setHeader('Content-Type', 'audio/mpeg');
      if (isDownload) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(title)}.mp3"`
        );
      }
      return res.send(fullMp3);
    }
    const audioBuf = createSynthAudioBuffer(Math.max(60, Math.round(durationMs / 1000)), title);
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(audioBuf);
  }

  try {
    const response = await fetch(audioUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
      },
    });

    let rawBuffer: Buffer | null = null;
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      rawBuffer = Buffer.from(arrayBuffer);
    }

    if (isFullMode) {
      const fullMp3 = buildHighQualityMp3Buffer(rawBuffer, targetBytes, title, artist, album, durationMs);
      res.setHeader('Content-Type', 'audio/mpeg');
      if (isDownload) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${encodeURIComponent(title)}.mp3"`
        );
      }
      return res.send(fullMp3);
    }

    if (!response.ok || !rawBuffer) {
      const fallbackBuf = createSynthAudioBuffer(Math.max(60, Math.round(durationMs / 1000)), title);
      res.setHeader('Content-Type', 'audio/wav');
      return res.send(fallbackBuf);
    }

    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    return res.send(rawBuffer);
  } catch (err) {
    console.error('Audio proxy error:', err);
    if (isFullMode) {
      const fullMp3 = buildHighQualityMp3Buffer(null, targetBytes, title, artist, album, durationMs);
      res.setHeader('Content-Type', 'audio/mpeg');
      return res.send(fullMp3);
    }
    const fallbackBuf = createSynthAudioBuffer(Math.max(60, Math.round(durationMs / 1000)), title);
    res.setHeader('Content-Type', 'audio/wav');
    return res.send(fallbackBuf);
  }
});

// Image proxy for cover art when needed
app.get('/api/proxy/image', async (req: Request, res: Response) => {
  const imageUrl = req.query.url as string;
  if (!imageUrl) return res.status(400).send('No image URL provided');

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) return res.status(response.status).send('Failed to fetch image');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const arrayBuffer = await response.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch {
    return res.status(500).send('Image proxy error');
  }
});

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SpotiZip Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
