import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { createPlaylist, getPlaylistDetail, listAllPlaylists } from '../src/myplaylists/index.js';
import { clearPlaylistImage, isSupportedImage, playlistImageFile, savePlaylistImage } from '../src/myplaylists/image.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const dirs: string[] = [];
const dataDir = (): string => { const d = mkdtempSync(join(tmpdir(), 'rune-plimg-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('a picture chosen for a playlist', () => {
  it('shows on the playlist and in the list, then goes away again', async () => {
    const db = openDb(':memory:');
    const dir = dataDir();
    const p = createPlaylist(db, { name: 'Mine' });
    expect(await savePlaylistImage(db, dir, p.id, PNG, 7)).toBe(true);
    expect(existsSync(playlistImageFile(dir, p.id))).toBe(true);
    const url = `/api/playlists/${encodeURIComponent(p.id)}/image?v=7`;
    expect(getPlaylistDetail(db, p.id)?.imageUrl).toBe(url);
    expect(listAllPlaylists(db).find((x) => x.id === p.id)?.imageUrl).toBe(url);
    clearPlaylistImage(db, dir, p.id);
    expect(getPlaylistDetail(db, p.id)?.imageUrl).toBeUndefined();
    expect(existsSync(playlistImageFile(dir, p.id))).toBe(false);
  });
  it('wins over the picture a Spotify sync stored', async () => {
    const db = openDb(':memory:');
    const p = createPlaylist(db, { name: 'Mine' });
    db.prepare('UPDATE playlists SET image_url = ? WHERE id = ?').run('https://i.scdn.co/x', p.id);
    await savePlaylistImage(db, dataDir(), p.id, PNG, 8);
    expect(getPlaylistDetail(db, p.id)?.imageUrl).toContain('/image?v=8');
  });
  it('refuses what is not a picture, without running ffmpeg on it', async () => {
    const db = openDb(':memory:');
    const p = createPlaylist(db, { name: 'Mine' });
    const m3u = Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\nhttp://127.0.0.1/secret\n');
    expect(isSupportedImage(m3u)).toBe(false);
    expect(await savePlaylistImage(db, dataDir(), p.id, m3u)).toBe(false);
    expect(getPlaylistDetail(db, p.id)?.imageUrl).toBeUndefined();
  });
});
