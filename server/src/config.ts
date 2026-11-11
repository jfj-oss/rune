import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

/** ReplayGain-style loudness normalisation for local playback. */
export type NormalizeMode = 'off' | 'track' | 'album';

export interface Config {
  libraryRoots: string[];
  dataDir: string;
  port: number;
  /** mpv audio device for the PC zone, e.g. "pipewire" or "alsa/hw:1,0" */
  audioDevice: string;
  userAgent: string; // MusicBrainz requires an identifying UA
  /** Loudness normalisation mode (default 'album'; the DB setting can override it). */
  normalize?: NormalizeMode;
  /** HTTPS address other devices use (Tailscale serve), e.g. https://horse.example.ts.net:8445 */
  publicUrl?: string;
  /** Spotify app client id (PKCE — there is no client secret). Never commit a real id. */
  spotifyClientId?: string;
  /** Spotify integration settings. */
  spotify?: {
    /** Requests allowed in a rolling 24 h window before background jobs stop (default 4000). */
    dailyBudget?: number;
    /** Read this PC's Spotify app over MPRIS instead of polling GET /me/player for it (default true). false brings
     *  the polling back. */
    mprisReads?: boolean;
    /** Phase 3 (default false): the pc zone's queue lives on the server (play/driver.ts) and plays local songs on mpv
     *  and Spotify songs in this PC's Spotify app with no tab open; the page is a plain remote for it. Off keeps the
     *  tab-driven mixed queue. */
    serverQueue?: boolean;
  };
  /**
   * Spotify Soloist (Spotify's headless Connect client): the zone that plays Spotify without the desktop app, and the
   * stream a phone can listen to. On by default when the binary and the key file both exist.
   */
  soloist?: {
    enabled?: boolean;
    /** Default ~/.local/bin/soloist */
    binary?: string;
    /** File holding the Soloist API key, mode 600 (default ~/.config/rune/soloist-key). Never put the key in config.json. */
    keyFile?: string;
    /** Spotify Connect device name (default "rune"). */
    deviceName?: string;
    /** Soloist's own data directory (default: Soloist's default, where --pair stored the session). */
    dataDir?: string;
    /** Loopback port of its WebSocket API (default 4547). */
    wsPort?: number;
    /** PipeWire null sink the phone stream is captured from (default "rune-phone"). */
    sink?: string;
    /** AAC bitrate of the phone stream (default 256). */
    hlsKbps?: number;
  };
  /** Optional Last.fm API key for a similarity fallback (ListenBrainz is primary; unset by default). */
  lastfmApiKey?: string;
  /** Name of the Spotify Connect device that represents this PC (default 'HORSE',
   *  the Spotify desktop app on the same machine). GET /api/zones matches it so the
   *  UI can route Spotify tracks to the PC's Spotify app. */
  pcSpotifyDevice?: string;
  /** Extra browser origins allowed to read the small CORS-enabled API that
   *  Megatron's "Play into call" tab uses (search, album/playlist details,
   *  cover art, audio stream). Megatron's own browser and desktop origins are
   *  always allowed; list other devices here, e.g.
   *  ["http://192.168.1.10:7420"]. */
  corsOrigins?: string[];
}

export function loadConfig(): Config {
  const file = new URL('../config.json', import.meta.url);
  const user = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const cfg: Config = {
    libraryRoots: ['/mnt/BIG data/Music'],
    dataDir: join(homedir(), '.local/share/liner'),
    port: 4545,
    audioDevice: 'pipewire',
    userAgent: 'Liner/0.1 ( personal music player, self-hosted )',
    normalize: 'album',
    pcSpotifyDevice: 'HORSE',
    ...user,
  };
  // Overrides for running a second, silent instance (tests / smoke checks).
  if (process.env.RUNE_PORT) cfg.port = Number(process.env.RUNE_PORT);
  if (process.env.RUNE_DATA_DIR) cfg.dataDir = process.env.RUNE_DATA_DIR;
  if (process.env.RUNE_AUDIO_DEVICE) cfg.audioDevice = process.env.RUNE_AUDIO_DEVICE;
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
