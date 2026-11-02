import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

export interface Config {
  libraryRoots: string[];
  dataDir: string;
  port: number;
  /** mpv audio device for the PC zone, e.g. "pipewire" or "alsa/hw:1,0" */
  audioDevice: string;
  userAgent: string; // MusicBrainz requires an identifying UA
  /** Spotify app client id (PKCE — there is no client secret). Never commit a real id. */
  spotifyClientId?: string;
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
    ...user,
  };
  // Overrides for running a second, silent instance (tests / smoke checks).
  if (process.env.RUNE_PORT) cfg.port = Number(process.env.RUNE_PORT);
  if (process.env.RUNE_DATA_DIR) cfg.dataDir = process.env.RUNE_DATA_DIR;
  if (process.env.RUNE_AUDIO_DEVICE) cfg.audioDevice = process.env.RUNE_AUDIO_DEVICE;
  mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
