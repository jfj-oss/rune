// Module interfaces. Each worker implements one; src/api wires them together.
import type { Db } from './db/index.js';
import type { Config } from './config.js';
import type { PlayerCommand, PlayerState, ScanProgress, Zone } from '@liner/shared';

/** Worker A — src/scan/index.ts exports `createScanner`. */
export interface Scanner {
  /** Walk all library roots, upsert albums/tracks/artists, remove vanished files.
   *  Incremental: skip files whose mtime+size are unchanged. */
  scan(onProgress?: (p: ScanProgress) => void): Promise<ScanProgress>;
}
export type CreateScanner = (db: Db, cfg: Config) => Scanner;

/** Worker B — src/match/index.ts exports `createMatcher`. */
export interface Matcher {
  /** Match every local album without a locked match; fills mb ids, confidence,
   *  canonical artist ids/names, release date, label, genres, credits, cover (if no local). */
  matchPending(onProgress?: (done: number, total: number) => void): Promise<void>;
  /** Manual fix: set release id, lock it, refetch. */
  setRelease(albumId: string, mbReleaseId: string): Promise<void>;
  /** Candidate releases for the "fix match" dialog. */
  candidates(albumId: string): Promise<{ mbReleaseId: string; title: string; artist: string; year?: number; tracks: number; country?: string; score: number }[]>;
}
export type CreateMatcher = (db: Db, cfg: Config) => Matcher;

/** Worker C — src/play/index.ts exports `createPcZone` and `streamHandler`. */
export interface PlaybackZone {
  readonly zone: Zone;
  state(): PlayerState;
  command(cmd: PlayerCommand): Promise<PlayerState>;
  onChange(cb: (s: PlayerState) => void): () => void;
  close(): Promise<void>;
}
export type CreatePcZone = (db: Db, cfg: Config) => Promise<PlaybackZone>;
