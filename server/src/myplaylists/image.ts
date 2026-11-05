// A picture the user chose for a playlist. Kept in rune only (a table + a file in the data dir), for rune and Spotify
// playlists alike: rune never changes the picture on Spotify, and a Spotify sync cannot overwrite it.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { ensureMyPlaylistSchema } from './schema.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const SIZE = 800;

/** JPEG, PNG, GIF or WebP by content. ffmpeg opens far more than pictures, so nothing else may reach it. */
export function isSupportedImage(b: Buffer): boolean {
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  const head = b.toString('latin1', 0, 12);
  return head.startsWith('GIF8') || (head.startsWith('RIFF') && head.endsWith('WEBP'));
}

const dirOf = (dataDir: string): string => join(dataDir, 'playlist-images');
export const playlistImageFile = (dataDir: string, id: string): string =>
  join(dirOf(dataDir), `${createHash('sha1').update(id).digest('hex')}.jpg`);

/** The URL of the chosen picture, or null. `v` changes with each new picture, so browsers never show the old one. */
export function playlistImageUrl(db: Db, id: string): string | null {
  const row = db.prepare('SELECT updated_at AS at FROM playlist_images WHERE playlist_id = ?').get(id) as { at: number } | undefined;
  return row ? `/api/playlists/${encodeURIComponent(id)}/image?v=${row.at}` : null;
}

/** Crop to a centred square and store it. False: the file is not a picture ffmpeg could read. */
export async function savePlaylistImage(db: Db, dataDir: string, id: string, data: Buffer, now: number = Date.now()): Promise<boolean> {
  ensureMyPlaylistSchema(db);
  if (!isSupportedImage(data)) return false;
  mkdirSync(dirOf(dataDir), { recursive: true });
  const out = playlistImageFile(dataDir, id);
  const src = `${out}.upload`;
  const tmp = `${out}.tmp.jpg`;
  writeFileSync(src, data);
  try {
    const ok = await new Promise<boolean>((resolve) => {
      execFile(
        'ffmpeg',
        ['-v', 'error', '-y', '-i', src, '-vf', `scale=${SIZE}:${SIZE}:force_original_aspect_ratio=increase,crop=${SIZE}:${SIZE}`, '-frames:v', '1', '-q:v', '3', tmp],
        { timeout: 20_000 },
        (err) => resolve(!err && existsSync(tmp)),
      );
    });
    if (!ok) return false;
    renameSync(tmp, out);
  } finally {
    rmSync(src, { force: true });
    rmSync(tmp, { force: true });
  }
  db.prepare('INSERT INTO playlist_images (playlist_id, updated_at) VALUES (?, ?) ON CONFLICT(playlist_id) DO UPDATE SET updated_at = excluded.updated_at').run(id, now);
  return true;
}

export function clearPlaylistImage(db: Db, dataDir: string, id: string): void {
  ensureMyPlaylistSchema(db);
  db.prepare('DELETE FROM playlist_images WHERE playlist_id = ?').run(id);
  rmSync(playlistImageFile(dataDir, id), { force: true });
}
