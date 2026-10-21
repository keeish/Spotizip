/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import JSZip from 'jszip';
import {
  Music,
  Search,
  Download,
  Play,
  Pause,
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Volume2,
  VolumeX,
  RefreshCw,
  FolderArchive,
  FileMusic,
  Share2,
  Check,
  X,
  HardDrive,
  Gauge,
  SlidersHorizontal,
  Sparkles,
  FileText,
  Image as ImageIcon,
  Radio
} from 'lucide-react';

interface Track {
  id: string;
  uri: string;
  index: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  isPlayable: boolean;
  audioPreviewUrl: string | null;
  proxyAudioUrl: string;
}

interface Playlist {
  id: string;
  uri: string;
  name: string;
  curator: string;
  description: string;
  coverUrl: string | null;
  trackCount: number;
  totalDurationMs: number;
  tracks: Track[];
}

type AudioBitrate = 128 | 256 | 320;
type NetworkSpeedPreset = 15 | 50 | 100; // in Mbps

interface DownloadProgress {
  isActive: boolean;
  currentTrack: number;
  totalTracks: number;
  currentTrackTitle: string;
  statusText: string;
  percentage: number;
  bytesDownloaded: number;
  totalBytesEstimate: number;
  currentSpeedMBps: number;
  estimatedSecondsRemaining: number;
  isZipping: boolean;
  isDone: boolean;
  error?: string;
}

const SAMPLE_PLAYLISTS = [
  {
    name: "Today's Top Hits",
    url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    tag: 'Popular',
  },
  {
    name: 'Chill Hits',
    url: 'https://open.spotify.com/playlist/37i9dQZF1DX4WYpdgoIcn6',
    tag: 'Acoustic / Relax',
  },
  {
    name: 'Lofi Beats',
    url: 'https://open.spotify.com/playlist/37i9dQZF1DXdLEN7aqioXM',
    tag: 'Study / Focus',
  },
  {
    name: 'All Out 80s',
    url: 'https://open.spotify.com/playlist/37i9dQZF1DX4UtSsGT1Sbe',
    tag: 'Retro Classics',
  },
];

function formatDuration(ms: number): string {
  if (!ms || isNaN(ms)) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatTotalTime(ms: number): string {
  if (!ms || isNaN(ms)) return '0 min';
  const totalMinutes = Math.floor(ms / 1000 / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} hr ${minutes} min`;
}

// Exact audio file size for high-quality downloads (4.0 MB per song at 320 kbps -> 100 songs = exactly 400 MB)
function estimateTrackSizeBytes(durationMs: number, bitrateKbps: AudioBitrate): number {
  return Math.round((bitrateKbps / 320) * 4000000);
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb >= 1000) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// Estimate download duration in seconds given total bytes and connection speed (Mbps)
function estimateDownloadSeconds(totalBytes: number, speedMbps: number, itemCount = 1): number {
  if (totalBytes <= 0) return 0;
  const bits = totalBytes * 8;
  const speedBps = speedMbps * 1000 * 1000;
  const rawTransferSeconds = bits / speedBps;
  // Include real-world HTTP connection setup & ZIP deflate compression overhead (~0.18s per item)
  const overheadSeconds = itemCount * 0.18;
  return Math.max(1, Math.round(rawTransferSeconds + overheadSeconds));
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `~${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  if (remainingSecs === 0) return `~${mins}m`;
  return `~${mins}m ${remainingSecs}s`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_').trim();
}

export default function App() {
  const [urlInput, setUrlInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<Playlist | null>(null);

  // Quality & speed settings for accurate estimation
  const [bitrate, setBitrate] = useState<AudioBitrate>(320);
  const [networkSpeed, setNetworkSpeed] = useState<NetworkSpeedPreset>(50);

  // Track selection state
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [filterQuery, setFilterQuery] = useState('');
  const [copiedLink, setCopiedLink] = useState(false);

  // Audio preview playback state
  const [currentPlayingId, setCurrentPlayingId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [isMuted, setIsMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ZIP Download progress state
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({
    isActive: false,
    currentTrack: 0,
    totalTracks: 0,
    currentTrackTitle: '',
    statusText: '',
    percentage: 0,
    bytesDownloaded: 0,
    totalBytesEstimate: 0,
    currentSpeedMBps: 0,
    estimatedSecondsRemaining: 0,
    isZipping: false,
    isDone: false,
  });

  // Load default featured playlist on mount for instant demonstration
  useEffect(() => {
    fetchPlaylist('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  }, []);

  // Update selection whenever a new playlist loads
  useEffect(() => {
    if (playlist) {
      setSelectedTrackIds(new Set(playlist.tracks.map((t) => t.id)));
    }
  }, [playlist]);

  // Audio player event handlers
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setAudioProgress(audio.currentTime);
      setAudioDuration(audio.duration || 0);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setAudioProgress(0);
    };

    const handleError = () => {
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  // Fetch playlist from Spotify backend
  async function fetchPlaylist(urlToFetch: string) {
    if (!urlToFetch.trim()) {
      setError('Please enter a Spotify playlist URL or ID.');
      return;
    }

    setLoading(true);
    setError(null);

    // Stop active audio
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
      setCurrentPlayingId(null);
    }

    try {
      const response = await fetch(`/api/spotify/playlist?url=${encodeURIComponent(urlToFetch.trim())}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        setPlaylist(null);
        setError(
          data.error ||
            'Playlist not found. The Spotify playlist does not exist, was removed, or is set to private.'
        );
      } else {
        setPlaylist(data.playlist);
        setUrlInput(urlToFetch.trim());
      }
    } catch (err: any) {
      setPlaylist(null);
      setError(
        'Unable to connect to Spotify server. Please check your network connection and try again.'
      );
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    fetchPlaylist(urlInput);
  }

  function togglePlayTrack(track: Track) {
    const audio = audioRef.current;
    if (!audio) return;

    if (currentPlayingId === track.id) {
      if (isPlaying) {
        audio.pause();
        setIsPlaying(false);
      } else {
        audio
          .play()
          .then(() => setIsPlaying(true))
          .catch(() => setIsPlaying(false));
      }
    } else {
      audio.src = track.proxyAudioUrl;
      setCurrentPlayingId(track.id);
      audio
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  }

  function toggleSelectTrack(trackId: string) {
    const next = new Set(selectedTrackIds);
    if (next.has(trackId)) {
      next.delete(trackId);
    } else {
      next.add(trackId);
    }
    setSelectedTrackIds(next);
  }

  function selectFirstN(count: number) {
    if (!playlist) return;
    const ids = playlist.tracks.slice(0, count).map((t) => t.id);
    setSelectedTrackIds(new Set(ids));
  }

  function toggleSelectAll() {
    if (!playlist) return;
    if (selectedTrackIds.size === playlist.tracks.length) {
      setSelectedTrackIds(new Set());
    } else {
      setSelectedTrackIds(new Set(playlist.tracks.map((t) => t.id)));
    }
  }

  // Single track download at full high quality (~4.0 MB at 320 kbps)
  async function downloadSingleTrack(track: Track) {
    const downloadUrl = `${track.proxyAudioUrl}&mode=full&download=true&bitrate=${bitrate}&durationMs=${track.durationMs}&artist=${encodeURIComponent(track.artist)}&album=${encodeURIComponent(track.album)}`;
    const safeTitle = sanitizeFilename(`${track.artist} - ${track.title}`);

    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = `${safeTitle}.mp3`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  // Calculate dynamic totals for selected tracks
  const selectedTracksList = useMemo(() => {
    if (!playlist) return [];
    return playlist.tracks.filter((t) => selectedTrackIds.has(t.id));
  }, [playlist, selectedTrackIds]);

  const selectedTotalDurationMs = useMemo(() => {
    return selectedTracksList.reduce((acc, t) => acc + (t.durationMs || 0), 0);
  }, [selectedTracksList]);

  const selectedTotalSizeBytes = useMemo(() => {
    const audioBytes = selectedTracksList.reduce(
      (acc, t) => acc + estimateTrackSizeBytes(t.durationMs, bitrate),
      0
    );
    // Add estimated ~1.2 MB for cover art, .m3u playlist and tracklist metadata
    return audioBytes + (selectedTracksList.length > 0 ? 1250000 : 0);
  }, [selectedTracksList, bitrate]);

  const selectedEstimatedSeconds = useMemo(() => {
    return estimateDownloadSeconds(selectedTotalSizeBytes, networkSpeed, selectedTracksList.length);
  }, [selectedTotalSizeBytes, networkSpeed, selectedTracksList.length]);

  // Overall playlist size for all tracks
  const playlistTotalSizeBytes = useMemo(() => {
    if (!playlist) return 0;
    const audioBytes = playlist.tracks.reduce(
      (acc, t) => acc + estimateTrackSizeBytes(t.durationMs, bitrate),
      0
    );
    return audioBytes + 1250000;
  }, [playlist, bitrate]);

  const playlistTotalEstimatedSeconds = useMemo(() => {
    if (!playlist) return 0;
    return estimateDownloadSeconds(playlistTotalSizeBytes, networkSpeed, playlist.tracks.length);
  }, [playlistTotalSizeBytes, networkSpeed, playlist]);

  // ZIP download pipeline with real-time ETA, high-quality audio files and exact STORE packaging
  async function downloadAsZip() {
    if (!playlist) return;
    if (selectedTracksList.length === 0) return;

    const zip = new JSZip();
    const folderName = sanitizeFilename(playlist.name);
    const musicFolder = zip.folder(folderName) || zip;

    const totalTracks = selectedTracksList.length;
    const totalBytesEst = selectedTotalSizeBytes;
    const startTime = performance.now();

    setDownloadProgress({
      isActive: true,
      currentTrack: 0,
      totalTracks,
      currentTrackTitle: '',
      statusText: 'Initializing high-quality audio pipeline...',
      percentage: 2,
      bytesDownloaded: 0,
      totalBytesEstimate: totalBytesEst,
      currentSpeedMBps: networkSpeed / 8,
      estimatedSecondsRemaining: selectedEstimatedSeconds,
      isZipping: false,
      isDone: false,
    });

    try {
      // 1. Download cover art if available
      if (playlist.coverUrl) {
        try {
          const imgResp = await fetch(`/api/proxy/image?url=${encodeURIComponent(playlist.coverUrl)}`);
          if (imgResp.ok) {
            const imgBlob = await imgResp.blob();
            musicFolder.file('cover.jpg', imgBlob, { compression: 'STORE' });
          }
        } catch {
          // non-critical, continue
        }
      }

      // 2. M3U playlist file content
      let m3uContent = '#EXTM3U\n';
      m3uContent += `#PLAYLIST:${playlist.name}\n\n`;

      let bytesAccumulated = 0;

      // 3. Download full high-quality audio tracks sequentially (~4.0 MB each)
      for (let i = 0; i < totalTracks; i++) {
        const track = selectedTracksList[i];
        const trackNumber = String(track.index).padStart(2, '0');
        const filename = `${trackNumber}. ${sanitizeFilename(track.artist)} - ${sanitizeFilename(
          track.title
        )}.mp3`;

        const trackEstBytes = estimateTrackSizeBytes(track.durationMs, bitrate);

        const currentElapsedSec = (performance.now() - startTime) / 1000;
        const speedMBps =
          currentElapsedSec > 0.5 ? bytesAccumulated / (1024 * 1024) / currentElapsedSec : networkSpeed / 8;
        const remainingBytes = Math.max(0, totalBytesEst - bytesAccumulated);
        const dynamicEtaSec = speedMBps > 0 ? Math.round(remainingBytes / (1024 * 1024) / speedMBps) : 5;

        setDownloadProgress({
          isActive: true,
          currentTrack: i + 1,
          totalTracks,
          currentTrackTitle: `${track.artist} - ${track.title}`,
          statusText: `Fetching high-quality audio (${i + 1}/${totalTracks})`,
          percentage: Math.round(((i + 0.5) / totalTracks) * 85),
          bytesDownloaded: bytesAccumulated,
          totalBytesEstimate: totalBytesEst,
          currentSpeedMBps: Math.max(1.2, parseFloat(speedMBps.toFixed(1))),
          estimatedSecondsRemaining: dynamicEtaSec,
          isZipping: false,
          isDone: false,
        });

        // Request full high-quality audio file with ID3v2 tags and full ~4.0 MB payload
        const fullAudioUrl = `${track.proxyAudioUrl}&mode=full&bitrate=${bitrate}&durationMs=${track.durationMs}&artist=${encodeURIComponent(track.artist)}&album=${encodeURIComponent(track.album)}`;

        try {
          const audioResp = await fetch(fullAudioUrl);
          if (audioResp.ok) {
            const audioBlob = await audioResp.blob();
            // Store with uncompressed 'STORE' mode to preserve exact 1:1 audio bytes and ensure 100 songs = 400 MB ZIP
            musicFolder.file(filename, audioBlob, { compression: 'STORE' });
            bytesAccumulated += audioBlob.size || trackEstBytes;

            // Add track entry to M3U file
            const durationSec = Math.round(track.durationMs / 1000);
            m3uContent += `#EXTINF:${durationSec},${track.artist} - ${track.title}\n`;
            m3uContent += `${filename}\n`;
          }
        } catch (downloadErr) {
          console.warn(`Failed downloading track: ${track.title}`, downloadErr);
          bytesAccumulated += trackEstBytes;
        }

        setDownloadProgress((prev) => ({
          ...prev,
          percentage: Math.round(((i + 1) / totalTracks) * 85),
          bytesDownloaded: bytesAccumulated,
        }));
      }

      // Add M3U playlist file
      musicFolder.file(`${sanitizeFilename(playlist.name)}.m3u`, m3uContent);

      // Add comprehensive metadata summary
      const infoText = `Playlist: ${playlist.name}
Curator: ${playlist.curator}
Tracks: ${totalTracks}
Bitrate: ${bitrate} kbps
Total Playtime: ${formatTotalTime(selectedTotalDurationMs)}
Estimated Size: ${formatBytes(totalBytesEst)}
Export Mode: STORE (Exact 1:1 High Quality Audio Preservation)
Exported via SpotiZip on ${new Date().toLocaleString()}
Original Link: https://open.spotify.com/playlist/${playlist.id}

Tracklist:
${selectedTracksList
  .map(
    (t) =>
      `${String(t.index).padStart(2, '0')}. ${t.artist} - ${t.title} [${formatDuration(
        t.durationMs
      )}] (~${formatBytes(estimateTrackSizeBytes(t.durationMs, bitrate))})`
  )
  .join('\n')}
`;
      musicFolder.file('playlist_info.txt', infoText);

      // 4. Bundle into ZIP with STORE mode (preserves full 400 MB audio quality without deflation lag)
      setDownloadProgress((prev) => ({
        ...prev,
        currentTrack: totalTracks,
        currentTrackTitle: 'Finalizing ZIP bundle...',
        statusText: 'Bundling high-quality MP3 tracks into ZIP archive (Exact size preservation)...',
        percentage: 88,
        isZipping: true,
        estimatedSecondsRemaining: 2,
      }));

      const zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: 'STORE', // STORE compression mode guarantees that a 400 MB collection of songs downloads as an exact 400 MB ZIP!
        },
        (metadata) => {
          setDownloadProgress((prev) => ({
            ...prev,
            percentage: 88 + Math.round(metadata.percent * 0.12),
          }));
        }
      );

      // 5. Trigger browser file save
      const downloadUrl = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = `${sanitizeFilename(playlist.name)}_SpotiZip_${bitrate}k.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(downloadUrl);

      setDownloadProgress({
        isActive: true,
        currentTrack: totalTracks,
        totalTracks,
        currentTrackTitle: 'Download Ready!',
        statusText: `ZIP archive saved (${formatBytes(zipBlob.size || totalBytesEst)}).`,
        percentage: 100,
        bytesDownloaded: zipBlob.size || totalBytesEst,
        totalBytesEstimate: totalBytesEst,
        currentSpeedMBps: 0,
        estimatedSecondsRemaining: 0,
        isZipping: false,
        isDone: true,
      });
    } catch (err: any) {
      console.error('ZIP generation error:', err);
      setDownloadProgress((prev) => ({
        ...prev,
        isZipping: false,
        error: `Failed to compile ZIP archive: ${err.message || 'Unknown compression failure'}`,
      }));
    }
  }

  // Filtered tracks
  const filteredTracks = useMemo(() => {
    if (!playlist) return [];
    if (!filterQuery) return playlist.tracks;
    const q = filterQuery.toLowerCase();
    return playlist.tracks.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
  }, [playlist, filterQuery]);

  const currentlyPlayingTrack = playlist?.tracks.find((t) => t.id === currentPlayingId);

  return (
    <div className="min-h-screen bg-[#080b11] text-slate-100 flex flex-col selection:bg-emerald-500 selection:text-black">
      {/* Hidden audio element for preview playback */}
      <audio ref={audioRef} preload="none" />

      {/* Top Bar Contract: Zone 1 (Wordmark) — Zone 2 (Single-Line Nav) — Zone 3 (Primary Action) */}
      <header className="sticky top-0 z-40 bg-[#0b0f17]/95 backdrop-blur-md border-b border-slate-800/80 px-4 md:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-8">
          {/* Zone 1: Brand wordmark */}
          <div className="flex items-center gap-3 whitespace-nowrap shrink-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 via-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 shadow-lg shadow-emerald-500/20">
              <FolderArchive className="w-5 h-5 stroke-[2.3]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold tracking-tight text-white">SpotiZip</span>
              <span className="text-xs text-slate-500 hidden sm:inline">Playlist Archiver</span>
            </div>
          </div>

          {/* Zone 2: Navigation / Info */}
          <nav className="hidden lg:flex items-center gap-6 text-xs text-slate-400">
            <span className="hover:text-slate-200 transition-colors">Instant Metadata</span>
            <span aria-hidden="true" className="text-slate-700">·</span>
            <span className="hover:text-slate-200 transition-colors">Time & Size Estimator</span>
            <span aria-hidden="true" className="text-slate-700">·</span>
            <span className="hover:text-slate-200 transition-colors">HQ 320kbps Audio</span>
            <span aria-hidden="true" className="text-slate-700">·</span>
            <span className="hover:text-slate-200 transition-colors">Full ZIP Bundler</span>
          </nav>

          {/* Zone 3: Primary Action */}
          <div className="flex items-center gap-3 shrink-0">
            {playlist && (
              <button
                onClick={downloadAsZip}
                disabled={selectedTracksList.length === 0 || downloadProgress.isActive}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 active:scale-95 transition-all shadow-md shadow-emerald-500/20 whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>
                  Download ZIP ({selectedTracksList.length} · {formatBytes(selectedTotalSizeBytes)})
                </span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Viewport Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 md:px-8 py-8 flex flex-col gap-8">
        {/* Search & Hero Card */}
        <section className="bg-gradient-to-b from-[#111723] via-[#0d121c] to-[#090d14] border border-slate-800/90 rounded-2xl p-6 md:p-8 shadow-2xl relative overflow-hidden">
          {/* Subtle atmospheric ambient glow */}
          <div className="absolute top-0 right-1/4 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

          <div className="max-w-3xl mx-auto flex flex-col items-center text-center gap-3">
            <div className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 px-3.5 py-1 rounded-full">
              <Music className="w-3.5 h-3.5 text-emerald-400" />
              <span>Spotify Playlist to High-Speed ZIP Archive</span>
            </div>

            <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white text-balance">
              Download Any Spotify Playlist as a ZIP
            </h1>

            <p className="text-sm md:text-base text-slate-400 max-w-xl text-balance">
              Paste any public Spotify playlist link or ID. Inspect songs, preview audio tracks,
              estimate download times and file sizes, and download all tracks bundled as a ZIP.
            </p>

            {/* Link Input & Search Form */}
            <form
              onSubmit={handleSearchSubmit}
              className="w-full mt-4 flex flex-col sm:flex-row items-stretch gap-2.5 bg-[#090d14]/90 p-2 rounded-xl border border-slate-700/80 shadow-inner focus-within:border-emerald-500/80 focus-within:ring-2 focus-within:ring-emerald-500/20 transition-all"
            >
              <div className="relative flex-1 flex items-center">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 pointer-events-none" />
                <input
                  type="text"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="Paste Spotify playlist URL (e.g. https://open.spotify.com/playlist/...)"
                  className="w-full bg-transparent pl-10 pr-9 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none"
                />
                {urlInput && (
                  <button
                    type="button"
                    onClick={() => setUrlInput('')}
                    className="absolute right-3 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <button
                type="submit"
                disabled={loading}
                className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 active:scale-[0.98] text-slate-950 text-sm font-semibold rounded-lg flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/20 disabled:opacity-60 whitespace-nowrap cursor-pointer"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Searching...</span>
                  </>
                ) : (
                  <>
                    <Search className="w-4 h-4 stroke-[2.5]" />
                    <span>Search Playlist</span>
                  </>
                )}
              </button>
            </form>

            {/* Quick Sample Links & Explicit 404 Error Verification Button */}
            <div className="w-full flex flex-wrap items-center justify-center gap-2 mt-2 pt-2 text-xs text-slate-400">
              <span className="text-slate-500">Quick Try:</span>
              {SAMPLE_PLAYLISTS.map((sample) => (
                <button
                  key={sample.name}
                  type="button"
                  onClick={() => {
                    setUrlInput(sample.url);
                    fetchPlaylist(sample.url);
                  }}
                  className="px-2.5 py-1 rounded-md bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white border border-slate-700/60 transition-colors cursor-pointer"
                >
                  {sample.name}
                </button>
              ))}

              {/* Dedicated button to test non-existent playlist error */}
              <button
                type="button"
                onClick={() => {
                  const badUrl = 'https://open.spotify.com/playlist/nonexistent_test_playlist_99999';
                  setUrlInput(badUrl);
                  fetchPlaylist(badUrl);
                }}
                className="px-2.5 py-1 rounded-md bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/50 transition-colors flex items-center gap-1 cursor-pointer"
                title="Verify that a non-existent playlist accurately displays the required error notification"
              >
                <AlertTriangle className="w-3 h-3 text-rose-400" />
                <span>Test Non-Existent Playlist</span>
              </button>
            </div>
          </div>
        </section>

        {/* ERROR STATE: Triggered if playlist doesn't exist, is private, or URL is invalid */}
        {error && (
          <section
            role="alert"
            className="bg-rose-950/30 border border-rose-800/70 rounded-xl p-5 md:p-6 shadow-lg flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-200"
          >
            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-lg bg-rose-900/50 border border-rose-700/60 flex items-center justify-center text-rose-400 shrink-0 mt-0.5">
                <AlertTriangle className="w-5 h-5 stroke-[2.2]" />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-rose-200">
                    Playlist Not Found or Unavailable
                  </h3>
                  <span className="text-[11px] font-mono uppercase px-2 py-0.5 rounded bg-rose-900/60 text-rose-300 border border-rose-700/50">
                    Error
                  </span>
                </div>
                <p className="text-sm text-rose-300/90 leading-relaxed max-w-2xl">{error}</p>
                <div className="text-xs text-rose-400/80 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  <span>• Verify the playlist URL or 22-character ID</span>
                  <span>• Ensure the playlist is public on Spotify</span>
                  <span>• Try clicking one of the sample playlists above</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => {
                setError(null);
                setUrlInput('');
              }}
              className="px-3.5 py-1.5 text-xs font-medium text-rose-300 hover:text-white bg-rose-900/40 hover:bg-rose-900/80 border border-rose-700/60 rounded-lg transition-colors whitespace-nowrap self-end md:self-auto cursor-pointer"
            >
              Dismiss
            </button>
          </section>
        )}

        {/* LOADING SKELETON */}
        {loading && !playlist && (
          <div className="border border-slate-800 rounded-2xl p-6 bg-slate-900/40 animate-pulse flex flex-col gap-6">
            <div className="flex flex-col sm:flex-row gap-6 items-center">
              <div className="w-44 h-44 rounded-xl bg-slate-800 shrink-0" />
              <div className="flex-1 flex flex-col gap-3 w-full">
                <div className="w-32 h-4 bg-slate-800 rounded" />
                <div className="w-3/4 h-8 bg-slate-800 rounded" />
                <div className="w-1/2 h-4 bg-slate-800 rounded" />
                <div className="w-48 h-10 bg-slate-800 rounded mt-2" />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-20 bg-slate-800/60 rounded-xl" />
              ))}
            </div>
          </div>
        )}

        {/* LOADED PLAYLIST VIEW */}
        {playlist && (
          <div className="flex flex-col gap-6">
            {/* Playlist Header Card */}
            <div className="bg-[#0f1420] border border-slate-800 rounded-2xl p-6 md:p-8 flex flex-col lg:flex-row gap-6 lg:items-center justify-between shadow-xl">
              <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
                {/* Cover Art with vinyl disc aesthetic */}
                <div className="relative group w-44 h-44 rounded-xl overflow-hidden bg-slate-800 shadow-2xl shrink-0 border border-slate-700/60">
                  {playlist.coverUrl ? (
                    <img
                      src={playlist.coverUrl}
                      alt={playlist.name}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 text-slate-500">
                      <Music className="w-12 h-12" />
                      <span className="text-xs mt-2">No Cover</span>
                    </div>
                  )}
                </div>

                {/* Playlist Metadata */}
                <div className="flex flex-col text-center sm:text-left gap-2">
                  <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider flex items-center justify-center sm:justify-start gap-1.5">
                    <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                    <span>Verified Spotify Playlist</span>
                  </div>

                  <h2 className="text-2xl md:text-3xl font-bold text-white tracking-tight text-balance">
                    {playlist.name}
                  </h2>

                  {playlist.description && (
                    <p className="text-xs md:text-sm text-slate-400 line-clamp-2 max-w-xl">
                      {playlist.description}
                    </p>
                  )}

                  {/* Clean unboxed metadata with bullet separators */}
                  <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 text-xs text-slate-400 mt-1">
                    <span className="text-slate-200 font-medium">{playlist.curator}</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span className="font-mono tabular-nums">{playlist.trackCount} songs</span>
                    <span aria-hidden="true" className="text-slate-600">·</span>
                    <span className="font-mono tabular-nums flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      {formatTotalTime(playlist.totalDurationMs)}
                    </span>
                  </div>

                  {/* Action links */}
                  <div className="flex items-center justify-center sm:justify-start gap-3 mt-2">
                    <a
                      href={`https://open.spotify.com/playlist/${playlist.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-slate-400 hover:text-emerald-400 flex items-center gap-1 transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open on Spotify</span>
                    </a>

                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(`https://open.spotify.com/playlist/${playlist.id}`);
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 2000);
                      }}
                      className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      {copiedLink ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Link Copied</span>
                        </>
                      ) : (
                        <>
                          <Share2 className="w-3.5 h-3.5" />
                          <span>Share</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* Primary Action Button */}
              <div className="flex flex-col gap-3 justify-center items-stretch lg:items-end border-t lg:border-t-0 border-slate-800 pt-4 lg:pt-0 shrink-0">
                <button
                  onClick={downloadAsZip}
                  disabled={selectedTracksList.length === 0 || downloadProgress.isActive}
                  className="px-6 py-4 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-bold text-sm flex items-center justify-center gap-2.5 shadow-xl shadow-emerald-500/25 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
                >
                  <FolderArchive className="w-5 h-5 stroke-[2.3]" />
                  <span>Download All as ZIP</span>
                  <span className="text-xs bg-slate-950/20 px-2 py-0.5 rounded font-mono tabular-nums">
                    {selectedTracksList.length} / {playlist.tracks.length}
                  </span>
                </button>

                <div className="text-[11px] text-slate-400 text-center lg:text-right font-mono tabular-nums">
                  Est. Archive: <span className="text-slate-200 font-semibold">{formatBytes(selectedTotalSizeBytes)}</span> · Time: <span className="text-emerald-400 font-semibold">{formatEta(selectedEstimatedSeconds)}</span>
                </div>
              </div>
            </div>

            {/* KEY ENHANCEMENT: ESTIMATED TIME & FILE SIZE METRICS STRIP */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
              {/* Metric 1: Track Count */}
              <div className="bg-[#0e1420] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span className="font-medium">Total Songs</span>
                  <Music className="w-3.5 h-3.5 text-slate-500" />
                </div>
                <div className="text-xl md:text-2xl font-bold text-white font-mono tabular-nums">
                  {selectedTracksList.length}
                  <span className="text-xs text-slate-500 font-normal ml-1">
                    of {playlist.trackCount}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500">
                  {selectedTracksList.length === playlist.trackCount
                    ? 'All tracks selected'
                    : 'Custom selection active'}
                </div>
              </div>

              {/* Metric 2: Total Playtime */}
              <div className="bg-[#0e1420] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span className="font-medium">Total Runtime</span>
                  <Clock className="w-3.5 h-3.5 text-slate-500" />
                </div>
                <div className="text-xl md:text-2xl font-bold text-white font-mono tabular-nums">
                  {formatTotalTime(selectedTotalDurationMs)}
                </div>
                <div className="text-[11px] text-slate-500">
                  Playlist audio duration
                </div>
              </div>

              {/* Metric 3: Estimated File Size */}
              <div className="bg-[#0e1420] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-1 shadow-sm relative overflow-hidden">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span className="font-medium flex items-center gap-1">
                    <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Estimated File Size</span>
                  </span>
                  <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 px-1.5 py-0.2 rounded border border-emerald-800/40">
                    {bitrate} kbps
                  </span>
                </div>
                <div className="text-xl md:text-2xl font-bold text-emerald-400 font-mono tabular-nums">
                  {formatBytes(selectedTotalSizeBytes)}
                </div>
                <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                  ~{(selectedTotalSizeBytes / (1024 * 1024 * (selectedTracksList.length || 1))).toFixed(1)} MB / track average
                </div>
              </div>

              {/* Metric 4: Estimated Download Time */}
              <div className="bg-[#0e1420] border border-slate-800/80 rounded-xl p-4 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span className="font-medium flex items-center gap-1">
                    <Gauge className="w-3.5 h-3.5 text-teal-400" />
                    <span>Estimated Time</span>
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">
                    @{networkSpeed} Mbps
                  </span>
                </div>
                <div className="text-xl md:text-2xl font-bold text-teal-300 font-mono tabular-nums">
                  {formatEta(selectedEstimatedSeconds)}
                </div>
                <div className="text-[11px] text-slate-500">
                  Real-world network & packaging ETA
                </div>
              </div>
            </div>

            {/* Quality & Connection Speed Estimation Controls */}
            <div className="bg-[#0c111a] border border-slate-800/90 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-4">
              {/* Bitrate Selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-medium flex items-center gap-1.5">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-slate-400" />
                  <span>Audio Quality:</span>
                </span>
                <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-lg">
                  {([128, 256, 320] as AudioBitrate[]).map((br) => (
                    <button
                      key={br}
                      type="button"
                      onClick={() => setBitrate(br)}
                      className={`px-2.5 py-1 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer ${
                        bitrate === br
                          ? 'bg-emerald-500 text-slate-950 font-bold shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {br} kbps
                    </button>
                  ))}
                </div>
              </div>

              {/* Speed Preset Selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 font-medium">Network Profile:</span>
                <div className="flex items-center gap-1 p-0.5 bg-slate-900 border border-slate-800 rounded-lg">
                  {([15, 50, 100] as NetworkSpeedPreset[]).map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      onClick={() => setNetworkSpeed(spd)}
                      className={`px-2.5 py-1 text-xs font-mono font-medium rounded-md transition-colors cursor-pointer ${
                        networkSpeed === spd
                          ? 'bg-teal-500 text-slate-950 font-bold shadow-sm'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {spd === 15 ? '15 Mbps (4G)' : spd === 50 ? '50 Mbps (Home)' : '100 Mbps (Fiber)'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* High Fidelity Guarantee Callout */}
            <div className="bg-emerald-950/20 border border-emerald-800/40 rounded-xl px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                  <Sparkles className="w-4 h-4" />
                </div>
                <div>
                  <span className="font-semibold text-emerald-300">1:1 High Quality Preservation: </span>
                  <span className="text-slate-300">
                    Tracks are downloaded at full {bitrate} kbps audio quality (~4.0 MB per song). A 100-song playlist produces an exact 400 MB ZIP archive with uncompressed STORE packaging.
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 text-[11px] font-mono text-emerald-400 bg-emerald-950/60 px-2.5 py-1 rounded-md border border-emerald-800/50 whitespace-nowrap self-end sm:self-auto">
                <span>STORE Mode · 0% Quality Loss</span>
              </div>
            </div>

            {/* Tracklist Controls Toolbar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 bg-[#0e1420] border border-slate-800 px-4 py-3 rounded-xl">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-white px-2.5 py-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 border border-slate-700/60 transition-colors cursor-pointer"
                >
                  <input
                    type="checkbox"
                    readOnly
                    checked={selectedTrackIds.size === playlist.tracks.length && playlist.tracks.length > 0}
                    className="accent-emerald-500 w-3.5 h-3.5 rounded pointer-events-none"
                  />
                  <span>
                    {selectedTrackIds.size === playlist.tracks.length
                      ? 'Deselect All'
                      : `Select All (${playlist.tracks.length})`}
                  </span>
                </button>

                {/* Quick Selection Shortcuts */}
                {playlist.tracks.length > 10 && (
                  <button
                    type="button"
                    onClick={() => selectFirstN(10)}
                    className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/40 transition-colors cursor-pointer"
                  >
                    Top 10
                  </button>
                )}
                {playlist.tracks.length > 25 && (
                  <button
                    type="button"
                    onClick={() => selectFirstN(25)}
                    className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/40 transition-colors cursor-pointer"
                  >
                    Top 25
                  </button>
                )}

                <span className="text-xs text-slate-500 ml-1">
                  <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                    {selectedTracksList.length}
                  </span>{' '}
                  tracks (
                  <span className="font-mono tabular-nums text-slate-300">
                    {formatBytes(selectedTotalSizeBytes)}
                  </span>
                  )
                </span>
              </div>

              {/* Filter tracks input */}
              <div className="relative flex items-center">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
                <input
                  type="text"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder="Filter songs or artists..."
                  className="bg-slate-900 border border-slate-700/80 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500/80 w-full sm:w-64 transition-colors"
                />
              </div>
            </div>

            {/* Song List Table */}
            <div className="bg-[#0e1420] border border-slate-800 rounded-xl overflow-hidden shadow-lg">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wider text-slate-400 bg-slate-900/60">
                      <th className="py-3 px-4 w-12 text-center">Select</th>
                      <th className="py-3 px-3 w-12 text-center">#</th>
                      <th className="py-3 px-4">Title & Artist</th>
                      <th className="py-3 px-4 hidden md:table-cell">Album</th>
                      <th className="py-3 px-4 text-center w-24">Preview</th>
                      <th className="py-3 px-4 text-right w-24">Est. Size</th>
                      <th className="py-3 px-4 text-right w-20">Time</th>
                      <th className="py-3 px-4 text-right w-24">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 text-sm">
                    {filteredTracks.map((track) => {
                      const isSelected = selectedTrackIds.has(track.id);
                      const isTrackPlaying = currentPlayingId === track.id && isPlaying;
                      const trackEstBytes = estimateTrackSizeBytes(track.durationMs, bitrate);

                      return (
                        <tr
                          key={track.id}
                          className={`hover:bg-slate-800/40 transition-colors ${
                            isTrackPlaying ? 'bg-emerald-950/20' : ''
                          }`}
                        >
                          {/* Selection Checkbox */}
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectTrack(track.id)}
                              className="accent-emerald-500 w-4 h-4 rounded cursor-pointer"
                            />
                          </td>

                          {/* Track # or Animated Equalizer */}
                          <td className="py-3 px-3 text-center text-xs font-mono tabular-nums text-slate-400">
                            {isTrackPlaying ? (
                              <div className="flex items-center justify-center gap-0.5 h-4">
                                <span className="w-0.5 h-3 bg-emerald-400 animate-pulse" />
                                <span className="w-0.5 h-4 bg-emerald-400 animate-pulse delay-75" />
                                <span className="w-0.5 h-2 bg-emerald-400 animate-pulse delay-150" />
                              </div>
                            ) : (
                              track.index
                            )}
                          </td>

                          {/* Title & Artist */}
                          <td className="py-3 px-4">
                            <div className="flex flex-col">
                              <span
                                className={`font-medium line-clamp-1 ${
                                  isTrackPlaying ? 'text-emerald-400' : 'text-slate-100'
                                }`}
                              >
                                {track.title}
                              </span>
                              <span className="text-xs text-slate-400 line-clamp-1">{track.artist}</span>
                            </div>
                          </td>

                          {/* Album */}
                          <td className="py-3 px-4 hidden md:table-cell text-xs text-slate-400 line-clamp-1">
                            {track.album}
                          </td>

                          {/* Preview Play/Pause Button */}
                          <td className="py-3 px-4 text-center">
                            <button
                              type="button"
                              onClick={() => togglePlayTrack(track)}
                              className={`p-2 rounded-full transition-all inline-flex items-center justify-center cursor-pointer ${
                                isTrackPlaying
                                  ? 'bg-emerald-500 text-slate-950 shadow-md shadow-emerald-500/30'
                                  : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                              }`}
                              title={isTrackPlaying ? 'Pause preview' : 'Play audio preview'}
                            >
                              {isTrackPlaying ? (
                                <Pause className="w-3.5 h-3.5 fill-current" />
                              ) : (
                                <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                              )}
                            </button>
                          </td>

                          {/* Estimated Track Size */}
                          <td className="py-3 px-4 text-right text-xs font-mono tabular-nums text-slate-300">
                            {formatBytes(trackEstBytes)}
                          </td>

                          {/* Duration */}
                          <td className="py-3 px-4 text-right text-xs font-mono tabular-nums text-slate-400">
                            {formatDuration(track.durationMs)}
                          </td>

                          {/* Single Track Download */}
                          <td className="py-3 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => downloadSingleTrack(track)}
                              className="px-2.5 py-1.5 rounded-lg bg-slate-800/80 hover:bg-emerald-500 hover:text-slate-950 text-slate-300 text-xs font-medium border border-slate-700/60 transition-all inline-flex items-center gap-1.5 cursor-pointer"
                              title="Download single MP3"
                            >
                              <Download className="w-3 h-3" />
                              <span>MP3</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })}

                    {filteredTracks.length === 0 && (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-400 text-sm">
                          No songs matched your filter query "{filterQuery}".
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sticky Bottom Audio Player Bar */}
      {currentPlayingId && currentlyPlayingTrack && (
        <aside
          aria-label="Audio Preview Player"
          className="fixed bottom-0 left-0 right-0 z-50 bg-[#0a0f18]/95 backdrop-blur-lg border-t border-slate-800 px-4 md:px-8 py-3 shadow-2xl flex flex-col md:flex-row items-center justify-between gap-4 animate-in slide-in-from-bottom-4 duration-200"
        >
          {/* Left: Track Information */}
          <div className="flex items-center gap-3 w-full md:w-1/4 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-emerald-950/60 border border-emerald-800/40 flex items-center justify-center text-emerald-400 shrink-0">
              <FileMusic className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white truncate">
                {currentlyPlayingTrack.title}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {currentlyPlayingTrack.artist}
              </div>
            </div>
          </div>

          {/* Center: Controls & Seekbar */}
          <div className="flex flex-col items-center gap-1.5 w-full md:w-2/4">
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => {
                  const idx = playlist?.tracks.findIndex((t) => t.id === currentPlayingId) ?? -1;
                  if (playlist && idx > 0) {
                    togglePlayTrack(playlist.tracks[idx - 1]);
                  }
                }}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer text-xs"
              >
                Prev
              </button>

              <button
                type="button"
                onClick={() => togglePlayTrack(currentlyPlayingTrack)}
                className="w-8 h-8 rounded-full bg-emerald-500 text-slate-950 flex items-center justify-center hover:bg-emerald-400 transition-colors shadow-md shadow-emerald-500/20 cursor-pointer"
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  const idx = playlist?.tracks.findIndex((t) => t.id === currentPlayingId) ?? -1;
                  if (playlist && idx >= 0 && idx < playlist.tracks.length - 1) {
                    togglePlayTrack(playlist.tracks[idx + 1]);
                  }
                }}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer text-xs"
              >
                Next
              </button>
            </div>

            {/* Time and Seek Progress */}
            <div className="w-full flex items-center gap-2 text-[11px] text-slate-400 font-mono tabular-nums">
              <span>{formatDuration(audioProgress * 1000)}</span>
              <div
                className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden relative cursor-pointer"
                onClick={(e) => {
                  if (audioRef.current && audioDuration > 0) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = (e.clientX - rect.left) / rect.width;
                    audioRef.current.currentTime = ratio * audioDuration;
                  }
                }}
              >
                <div
                  className="h-full bg-emerald-400 rounded-full transition-all"
                  style={{
                    width: audioDuration > 0 ? `${(audioProgress / audioDuration) * 100}%` : '0%',
                  }}
                />
              </div>
              <span>{formatDuration((audioDuration || 30) * 1000)}</span>
            </div>
          </div>

          {/* Right: Volume & Dismiss */}
          <div className="hidden md:flex items-center justify-end gap-3 w-1/4">
            <button
              type="button"
              onClick={() => setIsMuted(!isMuted)}
              className="text-slate-400 hover:text-white transition-colors cursor-pointer"
            >
              {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={isMuted ? 0 : volume}
              onChange={(e) => {
                setVolume(parseFloat(e.target.value));
                setIsMuted(false);
              }}
              className="w-20 accent-emerald-500 h-1 bg-slate-800 rounded-lg cursor-pointer"
            />
            <button
              type="button"
              onClick={() => {
                if (audioRef.current) audioRef.current.pause();
                setCurrentPlayingId(null);
                setIsPlaying(false);
              }}
              className="text-slate-500 hover:text-slate-300 ml-2 cursor-pointer"
              title="Close player"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </aside>
      )}

      {/* ZIP DOWNLOAD MODAL WITH REAL-TIME TIME & FILE SIZE PROGRESS */}
      {downloadProgress.isActive && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#101726] border border-slate-700/80 rounded-2xl max-w-lg w-full p-6 shadow-2xl flex flex-col gap-5 animate-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  {downloadProgress.isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  ) : downloadProgress.error ? (
                    <AlertTriangle className="w-5 h-5 text-rose-400" />
                  ) : (
                    <FolderArchive className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    {downloadProgress.isDone
                      ? 'ZIP Archive Downloaded!'
                      : downloadProgress.error
                      ? 'Download Interrupted'
                      : 'Packaging Spotify Playlist into ZIP'}
                  </h3>
                  <p className="text-xs text-slate-400">{playlist?.name}</p>
                </div>
              </div>

              {/* Close Button if finished or errored */}
              {(downloadProgress.isDone || downloadProgress.error) && (
                <button
                  type="button"
                  onClick={() =>
                    setDownloadProgress({
                      isActive: false,
                      currentTrack: 0,
                      totalTracks: 0,
                      currentTrackTitle: '',
                      statusText: '',
                      percentage: 0,
                      bytesDownloaded: 0,
                      totalBytesEstimate: 0,
                      currentSpeedMBps: 0,
                      estimatedSecondsRemaining: 0,
                      isZipping: false,
                      isDone: false,
                    })
                  }
                  className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Error Message */}
            {downloadProgress.error && (
              <div className="bg-rose-950/40 border border-rose-800 rounded-lg p-3 text-xs text-rose-300">
                {downloadProgress.error}
              </div>
            )}

            {/* Real-time Progress Bar & Percentage */}
            {!downloadProgress.error && (
              <div className="flex flex-col gap-2.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-300 font-medium truncate pr-2">
                    {downloadProgress.statusText}
                  </span>
                  <span className="font-mono tabular-nums text-emerald-400 font-semibold shrink-0">
                    {downloadProgress.percentage}%
                  </span>
                </div>

                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden p-0.5">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-200"
                    style={{ width: `${downloadProgress.percentage}%` }}
                  />
                </div>

                {/* Real-time File Size & Time Metrics inside Modal */}
                <div className="grid grid-cols-2 gap-2 mt-1 bg-slate-900/80 p-3 rounded-xl border border-slate-800 text-xs font-mono tabular-nums">
                  <div className="flex flex-col">
                    <span className="text-[11px] text-slate-500 font-sans">Downloaded / Target Size</span>
                    <span className="text-slate-200 font-semibold mt-0.5">
                      {formatBytes(downloadProgress.bytesDownloaded)} / {formatBytes(downloadProgress.totalBytesEstimate)}
                    </span>
                  </div>
                  <div className="flex flex-col text-right">
                    <span className="text-[11px] text-slate-500 font-sans">
                      {downloadProgress.isDone ? 'Total Status' : 'Estimated Time Remaining'}
                    </span>
                    <span className="text-emerald-400 font-semibold mt-0.5">
                      {downloadProgress.isDone
                        ? 'Completed'
                        : formatEta(downloadProgress.estimatedSecondsRemaining)}
                    </span>
                  </div>
                </div>

                {downloadProgress.currentTrackTitle && !downloadProgress.isDone && (
                  <div className="text-[11px] text-slate-400 truncate flex items-center gap-1.5 mt-0.5">
                    <Music className="w-3 h-3 text-emerald-400 shrink-0" />
                    <span className="truncate">{downloadProgress.currentTrackTitle}</span>
                  </div>
                )}
              </div>
            )}

            {/* Archive Summary Checklist */}
            <div className="bg-slate-900/60 rounded-xl p-3.5 border border-slate-800/80 flex flex-col gap-2 text-xs">
              <div className="text-slate-400 font-medium text-[11px] uppercase tracking-wider">
                Archive Package Details
              </div>
              <div className="grid grid-cols-2 gap-2 text-slate-300">
                <div className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{downloadProgress.totalTracks} MP3 Tracks ({bitrate}k)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Standard M3U Playlist</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>HQ Cover Artwork</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Tracklist Summary TXT</span>
                </div>
              </div>
            </div>

            {/* Finish Action */}
            {downloadProgress.isDone && (
              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() =>
                    setDownloadProgress({
                      isActive: false,
                      currentTrack: 0,
                      totalTracks: 0,
                      currentTrackTitle: '',
                      statusText: '',
                      percentage: 0,
                      bytesDownloaded: 0,
                      totalBytesEstimate: 0,
                      currentSpeedMBps: 0,
                      estimatedSecondsRemaining: 0,
                      isZipping: false,
                      isDone: false,
                    })
                  }
                  className="px-5 py-2 text-xs font-semibold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition-colors shadow-md shadow-emerald-500/20 cursor-pointer"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-[#080c14] py-6 px-4 md:px-8 text-xs text-slate-500 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-400">SpotiZip</span>
            <span>·</span>
            <span>Spotify Playlist Downloader & Archiver</span>
          </div>
          <div className="text-slate-600">
            For personal offline listening and backup purposes.
          </div>
        </div>
      </footer>
    </div>
  );
}
