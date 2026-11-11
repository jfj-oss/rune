// Developer self-check: analyse 30 real tracks from 10 albums against a throwaway
// copy of the user's database. The library is opened read-only for the copy and
// never written; all loudness rows go to a temp database.
//
//   pnpm -C server exec tsx scripts/loudness-selfcheck.ts
//
// Prints album, track, LUFS, true peak and applied gain, checks that quiet old
// masters get positive gain and loud modern masters negative, and reports the
// analysis throughput in tracks/minute.

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { createLoudness, gainInfoForTrack, measureLoudness } from '../src/loudness/index.js';

interface AlbumRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
}

interface TrackRow {
  id: string;
  album_id: string;
  title: string;
  disc: number;
  number: number;
  path: string;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  file_mtime: number | null;
}

interface Printed {
  album: AlbumRow;
  track: TrackRow;
  lufs: number | null;
  truePeakDb: number | null;
  gainAlbumDb: number;
  gainTrackDb: number;
  albumLufs: number | null;
  ms: number;
}

function fmt(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value) ? '   -  ' : value.toFixed(digits);
}

function signed(value: number): string {
  const magnitude = Math.abs(value).toFixed(1);
  return value > 0 ? `+${magnitude}` : value < 0 ? `-${magnitude}` : ' 0.0';
}

/** Pick up to `count` tracks evenly spread through the album (first/middle/last). */
function pickTracks(db: Db, albumId: string, count: number): TrackRow[] {
  const rows = db
    .prepare(
      `SELECT id, album_id, title, disc, number, path, cue_start_ms, cue_end_ms, file_mtime
         FROM tracks WHERE album_id = ? AND path IS NOT NULL ORDER BY disc, number`,
    )
    .all(albumId) as TrackRow[];
  const usable = rows.filter((r) => existsSync(r.path));
  if (usable.length <= count) return usable;
  if (count <= 1) return usable.slice(0, Math.max(0, count));
  const indexes = new Set<number>();
  for (let i = 0; i < count; i++) {
    indexes.add(Math.round((i * (usable.length - 1)) / (count - 1)));
  }
  return [...indexes].sort((a, b) => a - b).map((i) => usable[i]!);
}

/**
 * Pick the old albums to sample. A first-track probe finds quiet masters
 * (below -18 LUFS, which need a boost); the rest of the slots are spread across
 * the pre-1990 catalogue. This is only the selection pass — the report's 30
 * tracks are analysed afterwards and printed in full.
 */
async function chooseOldAlbums(db: Db, old: AlbumRow[], count: number): Promise<AlbumRow[]> {
  const quiet: { album: AlbumRow; lufs: number }[] = [];
  for (const album of old) {
    const track = pickTracks(db, album.id, 1)[0];
    if (!track) continue;
    const result = await measureLoudness(
      { path: track.path, startMs: track.cue_start_ms, endMs: track.cue_end_ms },
      { nice: true },
    );
    if (result.lufs != null && result.lufs < -18) quiet.push({ album, lufs: result.lufs });
  }
  quiet.sort((a, b) => a.lufs - b.lufs);
  console.log(
    `selection probe: ${old.length} old albums, ${quiet.length} with a track below -18 LUFS`,
  );
  const out: AlbumRow[] = [];
  const seen = new Set<string>();
  const add = (album: AlbumRow | undefined): void => {
    if (!album || seen.has(album.id) || out.length >= count) return;
    if (pickTracks(db, album.id, 3).length < 3) return;
    seen.add(album.id);
    out.push(album);
  };
  for (const { album } of quiet.slice(0, Math.max(1, count - 2))) add(album);
  const step = Math.max(1, Math.floor(old.length / count));
  for (let i = 0; i < old.length && out.length < count; i += step) add(old[i]);
  for (const album of old) add(album);
  return out.slice(0, count);
}

/**
 * Five albums spread across the pre-1990 catalogue and five from 2000 onwards,
 * so the report covers genuinely old, quiet masters as well as modern loud ones.
 */
function spread(pool: AlbumRow[], count: number): AlbumRow[] {
  if (pool.length === 0) return [];
  const out: AlbumRow[] = [];
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.round((i * (pool.length - 1)) / (count - 1));
    out.push(pool[index]!);
  }
  return out;
}

async function chooseAlbums(db: Db): Promise<AlbumRow[]> {
  const albums = db
    .prepare(
      `SELECT a.id, a.title, ar.name AS artist, a.year
         FROM albums a JOIN artists ar ON ar.id = a.artist_id
        WHERE a.source = 'local'
          AND (SELECT COUNT(*) FROM tracks t WHERE t.album_id = a.id AND t.path IS NOT NULL) >= 3
        ORDER BY (a.year IS NULL OR a.year = 0), a.year, ar.name, a.title`,
    )
    .all() as AlbumRow[];
  const old = albums.filter((a) => a.year != null && a.year > 0 && a.year <= 1989);
  const modern = albums.filter((a) => a.year != null && a.year >= 2000);
  const picked: AlbumRow[] = [];
  const seen = new Set<string>();
  const add = (album: AlbumRow | undefined): void => {
    if (!album || seen.has(album.id)) return;
    if (pickTracks(db, album.id, 3).length < 3) return;
    seen.add(album.id);
    picked.push(album);
  };
  for (const album of await chooseOldAlbums(db, old, 5)) add(album);
  for (const album of spread(modern, 5)) add(album);
  for (const album of albums) {
    if (picked.length >= 10) break;
    add(album);
  }
  return picked.slice(0, 10);
}

async function main(): Promise<void> {
  const realDataDir = process.env.LINER_DATA_DIR ?? join(homedir(), '.local/share/liner');
  const realDbPath = join(realDataDir, 'liner.db');
  if (!existsSync(realDbPath)) {
    console.error(`no library database at ${realDbPath}`);
    process.exitCode = 1;
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'liner-loudness-selfcheck-'));
  const tempDbPath = join(tempRoot, 'liner.db');

  // Consistent copy including the WAL; the original is opened read-only.
  const source = new Database(realDbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(tempDbPath);
  } finally {
    source.close();
  }

  const db = openDb(tempDbPath);
  const cfg: Config = {
    libraryRoots: ['/path/to/Music'],
    dataDir: tempRoot,
    port: 0,
    audioDevice: 'null',
    userAgent: 'Liner/0.1 loudness self-check',
    normalize: 'album',
  };

  // Force real measurement (ignore any embedded ReplayGain tags) so the speed
  // and LUFS figures reflect ffmpeg decoding, not tag reads.
  const loudness = createLoudness(db, cfg, { tags: async () => ({}) });

  const albums = await chooseAlbums(db);
  if (albums.length < 10) {
    console.error(`only ${albums.length} suitable albums found; need 10`);
    process.exitCode = 1;
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    return;
  }

  const work: { album: AlbumRow; tracks: TrackRow[] }[] = albums.map((album) => ({
    album,
    tracks: pickTracks(db, album.id, 3),
  }));
  const totalTracks = work.reduce((n, w) => n + w.tracks.length, 0);

  console.log(`library db: ${realDbPath} (copied read-only to ${tempDbPath})`);
  console.log(`albums: ${albums.length}, tracks: ${totalTracks}\n`);

  const printed: Printed[] = [];
  const started = Date.now();
  for (const { album, tracks } of work) {
    for (const track of tracks) {
      const t0 = Date.now();
      const outcome = await loudness.analyseTrack(track.id);
      const elapsed = Date.now() - t0;
      const albumGain = gainInfoForTrack(db, track.id, 'album');
      const trackGain = gainInfoForTrack(db, track.id, 'track');
      const row = db
        .prepare('SELECT album_lufs FROM track_loudness WHERE track_id = ?')
        .get(track.id) as { album_lufs: number | null } | undefined;
      printed.push({
        album,
        track,
        lufs: outcome.lufs,
        truePeakDb: outcome.truePeakDb,
        gainAlbumDb: albumGain?.gainDb ?? 0,
        gainTrackDb: trackGain?.gainDb ?? 0,
        albumLufs: row?.album_lufs ?? null,
        ms: elapsed,
      });
      console.log(
        `${signed(albumGain?.gainDb ?? 0).padStart(6)} dB  ` +
          `${fmt(outcome.lufs).padStart(7)} LUFS  ${fmt(outcome.truePeakDb).padStart(7)} dBTP  ` +
          `${(elapsed / 1000).toFixed(1).padStart(5)}s  ${album.artist} — ${track.title}`,
      );
    }
    console.log(`  album: ${album.artist} — ${album.title} (${album.year ?? '?'})`);
  }
  const elapsedMs = Date.now() - started;

  // Album loudness is recalculated after every track, so report the final values
  // (the per-track lines above show the provisional gain available at that point).
  for (const p of printed) {
    p.gainAlbumDb = gainInfoForTrack(db, p.track.id, 'album')?.gainDb ?? 0;
    p.gainTrackDb = gainInfoForTrack(db, p.track.id, 'track')?.gainDb ?? 0;
    const row = db
      .prepare('SELECT album_lufs FROM track_loudness WHERE track_id = ?')
      .get(p.track.id) as { album_lufs: number | null } | undefined;
    p.albumLufs = row?.album_lufs ?? null;
  }

  console.log('\n=== results');
  console.log(
    'album'.padEnd(36) +
      'track'.padEnd(40) +
      'LUFS'.padStart(8) +
      'truePeak'.padStart(10) +
      'gain(album)'.padStart(13) +
      'gain(track)'.padStart(13),
  );
  for (const p of printed) {
    const albumLabel = `${p.album.artist} — ${p.album.title}`.slice(0, 35);
    const trackLabel = `${p.track.disc}.${p.track.number} ${p.track.title}`.slice(0, 39);
    console.log(
      albumLabel.padEnd(36) +
        trackLabel.padEnd(40) +
        fmt(p.lufs).padStart(8) +
        fmt(p.truePeakDb).padStart(10) +
        signed(p.gainAlbumDb).padStart(13) +
        signed(p.gainTrackDb).padStart(13),
    );
  }

  console.log('\n=== album loudness');
  const byAlbum = new Map<string, Printed[]>();
  for (const p of printed) {
    const list = byAlbum.get(p.album.id);
    if (list) list.push(p);
    else byAlbum.set(p.album.id, [p]);
  }
  for (const list of byAlbum.values()) {
    const first = list[0]!;
    console.log(
      `${first.album.artist} — ${first.album.title} (${first.album.year ?? '?'}): ` +
        `${fmt(first.albumLufs)} LUFS, ${list.length} tracks analysed`,
    );
  }

  const typical = (p: Printed): number => (p.lufs == null ? 0 : p.gainTrackDb);
  const oldTracks = printed.filter(
    (p) => p.album.year != null && p.album.year > 0 && p.album.year <= 1989,
  );
  const modernTracks = printed.filter(
    (p) => p.album.year != null && p.album.year >= 2000,
  );
  const positive = (list: Printed[]): number => list.filter((p) => typical(p) > 0).length;

  console.log('\n=== checks');
  console.log(
    `quiet old masters (year <= 1989): ${oldTracks.length} tracks, ${positive(oldTracks)} with positive track gain`,
  );
  console.log(
    `modern masters (year >= 2000):    ${modernTracks.length} tracks, ${modernTracks.length - positive(modernTracks)} with negative track gain`,
  );
  const tracksPerMin = elapsedMs > 0 ? (printed.length / elapsedMs) * 60_000 : 0;
  console.log(
    `analysis speed: ${printed.length} tracks in ${(elapsedMs / 1000).toFixed(1)}s = ${tracksPerMin.toFixed(2)} tracks/min`,
  );

  if (oldTracks.length > 0 && positive(oldTracks) === 0) {
    console.log('WARN: no old (<=1989) master needed a boost; check selection or measurements');
  }
  if (modernTracks.length > 0 && positive(modernTracks) === modernTracks.length) {
    console.log('WARN: every modern (>=2000) master needed a boost; check selection or measurements');
  }

  db.close();
  if (process.env.LINER_SELFCHECK_KEEP !== '1') rmSync(tempRoot, { recursive: true, force: true });
  else console.log(`kept temp db: ${tempDbPath}`);
}

await main();
