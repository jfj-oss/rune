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
  /** Optional Last.fm API key for a similarity fallback (ListenBrainz is primary; unset by default). */
  lastfmApiKey?: string;
  /** Name of the Spotify Connect device that represents this PC (default 'HORSE',
   *  the Spotify desktop app on the same machine). GET /api/zones matches it so the
   *  UI can route Spotify tracks to the PC's Spotify app. */
  pcSpotifyDevice?: string;
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
