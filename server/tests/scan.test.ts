import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { ids, openDb } from '../src/db/index.js';
import { createScanner, type ScannerWithStats } from '../src/scan/index.js';
import type { ScanProgress } from '@liner/shared';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface FlacOptions {
  title?: string;
  artist?: string;
  album?: string;
  albumartist?: string;
  track?: number;
  disc?: number;
  date?: string;
  genre?: string;
  seconds?: number;
  picture?: string;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeFlac(path: string, opts: FlacOptions = {}): void {
  const args = [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${opts.seconds ?? 0.5}`,
  ];
  if (opts.picture) args.push('-i', opts.picture);
  if (opts.picture) args.push('-map', '0:a', '-map', '1:v', '-c:v', 'png', '-disposition:v', 'attached_pic');
  args.push('-c:a', 'flac');
  const tags: Record<string, string | number | undefined> = {
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    album_artist: opts.albumartist,
    track: opts.track,
    disc: opts.disc,
    date: opts.date,
    genre: opts.genre,
  };
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined) args.push('-metadata', `${key}=${value}`);
  }
  args.push(path);
  ffmpeg(args);
}

let root: string;
let library: string;
let dataDir: string;
let cfg: Config;
let db: ReturnType<typeof openDb>;
let scanner: ScannerWithStats;

const albumOneFolder = (): string => join(library, 'Artist One - Album One (1999) [FLAC]');
const cueFile = (): string => join(library, 'Cue Album', 'Cue Album.flac');
const noTagsFolder = (): string => join(library, 'No Tags Artist - No Tags Album (1985) [FLAC]');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'liner-scan-'));
  library = join(root, 'library');
  dataDir = join(root, 'data');
  mkdirSync(library, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  // 1. Normal tagged album with a folder cover.
  const albumOne = albumOneFolder();
  mkdirSync(albumOne, { recursive: true });
  makeFlac(join(albumOne, '01 - First.flac'), {
    title: 'First',
    artist: 'Artist One',
    album: 'Album One',
    albumartist: 'Artist One',
    track: 1,
    date: '1999',
    genre: 'Rock',
  });
  makeFlac(join(albumOne, '02 - Second.flac'), {
    title: 'Second',
    artist: 'Artist One',
    album: 'Album One',
    albumartist: 'Artist One',
    track: 2,
    date: '1999',
    genre: 'Rock',
  });
  writeFileSync(join(albumOne, 'folder.jpg'), PNG_1X1);

  // 2. Disc subfolders must merge into one album with disc numbers.
  const discPack = join(library, 'Disc Pack');
  mkdirSync(join(discPack, 'CD1'), { recursive: true });
  mkdirSync(join(discPack, 'CD2'), { recursive: true });
  makeFlac(join(discPack, 'CD1', '01 - One.flac'), {
    title: 'Disc One Track',
    artist: 'Disc Artist',
    album: 'Disc Album',
    albumartist: 'Disc Artist',
    track: 1,
    disc: 1,
  });
  makeFlac(join(discPack, 'CD2', '01 - Two.flac'), {
    title: 'Disc Two Track',
    artist: 'Disc Artist',
    album: 'Disc Album',
    albumartist: 'Disc Artist',
    track: 1,
    disc: 2,
  });

  // 3. A dump folder with two different album tags splits into two albums.
  const dump = join(library, 'Mixtape Dump');
  mkdirSync(dump, { recursive: true });
  makeFlac(join(dump, 'a.flac'), { title: 'A', artist: 'Artist A', album: 'Comp A', track: 1 });
  makeFlac(join(dump, 'b.flac'), { title: 'B', artist: 'Artist B', album: 'Comp B', track: 1 });

  // 4. Untagged files: everything comes from the folder name.
  const noTags = noTagsFolder();
  mkdirSync(noTags, { recursive: true });
  makeFlac(join(noTags, '01 First Song.flac'));
  makeFlac(join(noTags, '02 Second Song.flac'));

  // 5. Single-FILE cue: the .wav in the cue matches the .flac by basename.
  const cueFolder = join(library, 'Cue Album');
  mkdirSync(cueFolder, { recursive: true });
  makeFlac(join(cueFolder, 'Cue Album.flac'), {
    title: 'Cue Album Title Tag',
    artist: 'Cue Artist',
    album: 'Cue Album',
    seconds: 3,
  });
  writeFileSync(
    join(cueFolder, 'Cue Album.cue'),
    [
      'PERFORMER "Cue Artist"',
      'TITLE "Cue Album"',
      'REM DATE 2001',
      'FILE "Cue Album.wav" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "Cue One"',
      '    INDEX 01 00:00:00',
      '  TRACK 02 AUDIO',
      '    TITLE "Cue Two"',
      '    INDEX 01 00:01:00',
      '  TRACK 03 AUDIO',
      '    TITLE "Cue Three"',
      '    INDEX 01 00:02:00',
      '',
    ].join('\r\n'),
  );

  // 6. Multi-FILE cue must be ignored: use the individual tagged files.
  const multiCue = join(library, 'Multi File Cue');
  mkdirSync(multiCue, { recursive: true });
  makeFlac(join(multiCue, '01 - Tag A.flac'), {
    title: 'Tag A',
    artist: 'Multi Artist',
    album: 'Multi Cue Album',
    track: 1,
  });
  makeFlac(join(multiCue, '02 - Tag B.flac'), {
    title: 'Tag B',
    artist: 'Multi Artist',
    album: 'Multi Cue Album',
    track: 2,
  });
  writeFileSync(
    join(multiCue, 'Multi.cue'),
    [
      'TITLE "Cue Album Title"',
      'FILE "01 - Tag A.flac" WAVE',
      '  TRACK 01 AUDIO',
      '    TITLE "Cue A"',
      '    INDEX 01 00:00:00',
      'FILE "02 - Tag B.flac" WAVE',
      '  TRACK 02 AUDIO',
      '    TITLE "Cue B"',
      '    INDEX 01 00:00:00',
      '',
    ].join('\n'),
  );

  // 7. Three different artists with no albumartist tag -> Various Artists.
  const va = join(library, 'VA Album');
  mkdirSync(va, { recursive: true });
  makeFlac(join(va, '01.flac'), { title: 'One', artist: 'Artist X', album: 'VA Album', track: 1 });
  makeFlac(join(va, '02.flac'), { title: 'Two', artist: 'Artist Y', album: 'VA Album', track: 2 });
  makeFlac(join(va, '03.flac'), { title: 'Three', artist: 'Artist Z', album: 'VA Album', track: 3 });

  // 8. Embedded-only cover must be extracted into dataDir/covers.
  const embedded = join(library, 'Embedded Cover Album');
  mkdirSync(embedded, { recursive: true });
  const coverPng = join(root, 'cover.png');
  writeFileSync(coverPng, PNG_1X1);
  makeFlac(join(embedded, '01 - Embedded.flac'), {
    title: 'Embedded',
    artist: 'Embed Artist',
    album: 'Embedded Cover Album',
    track: 1,
    picture: coverPng,
  });

  cfg = {
    libraryRoots: [library],
    dataDir,
    port: 0,
    audioDevice: 'pipewire',
    userAgent: 'test',
  };
  db = openDb(join(root, 'scan.db'));
  scanner = createScanner(db, cfg);
});

afterAll(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  rmSync(root, { recursive: true, force: true });
});

function albumRow(title: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM albums WHERE title = ?').get(title) as
    | Record<string, unknown>
    | undefined;
  expect(row, `album ${title}`).toBeTruthy();
  return row!;
}

function tracksOf(albumId: string): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM tracks WHERE album_id = ? ORDER BY disc, number')
    .all(albumId) as Record<string, unknown>[];
}

function artistName(artistId: string): string | undefined {
  const row = db.prepare('SELECT name FROM artists WHERE id = ?').get(artistId) as
    | { name: string }
    | undefined;
  return row?.name;
}

describe('scanner', () => {
  it('performs a full first scan and groups files correctly', async () => {
    const progress: ScanProgress[] = [];
    const stats = await scanner.scan((p) => progress.push(p));

    expect(stats.filesSeen).toBe(15);
    expect(stats.changedFiles).toBe(15);
    expect(stats.errors).toBe(0);
    expect(stats.albumsFound).toBe(9);
    expect(stats.cueAlbums).toBe(1);
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.running)).toBe(true);
    expect(progress[progress.length - 1]!.running).toBe(false);

    // --- normal album + cover + format
    const albumOne = albumRow('Album One');
    expect(artistName(String(albumOne.artist_id))).toBe('Artist One');
    expect(albumOne.year).toBe(1999);
    expect(albumOne.format).toBe('FLAC 16/44.1');
    expect(String(albumOne.cover_path)).toBe(join(albumOneFolder(), 'folder.jpg'));
    expect(albumOne.folder_path).toBe(albumOneFolder());
    expect(tracksOf(String(albumOne.id))).toHaveLength(2);
    expect(tracksOf(String(albumOne.id)).map((t) => t.title)).toEqual(['First', 'Second']);
    expect(tracksOf(String(albumOne.id)).map((t) => t.number)).toEqual([1, 2]);

    // --- disc subfolders merged
    const discAlbum = albumRow('Disc Album');
    const discTracks = tracksOf(String(discAlbum.id));
    expect(discTracks).toHaveLength(2);
    expect(discTracks.map((t) => t.disc)).toEqual([1, 2]);
    expect(discTracks.map((t) => t.title)).toEqual(['Disc One Track', 'Disc Two Track']);
    expect(discAlbum.folder_path).toBe(join(library, 'Disc Pack'));

    // --- folder with two album tags split, using groupKey in the album id
    const compA = albumRow('Comp A');
    const compB = albumRow('Comp B');
    expect(compA.id).not.toBe(compB.id);
    expect(compA.id).toBe(ids.localAlbum(join(library, 'Mixtape Dump'), 'comp a'));
    expect(compB.id).toBe(ids.localAlbum(join(library, 'Mixtape Dump'), 'comp b'));
    expect(tracksOf(String(compA.id))).toHaveLength(1);
    expect(tracksOf(String(compB.id))).toHaveLength(1);

    // --- untagged files fall back to the folder name
    const noTags = albumRow('No Tags Album');
    expect(artistName(String(noTags.artist_id))).toBe('No Tags Artist');
    expect(noTags.year).toBe(1985);
    const noTagsTracks = tracksOf(String(noTags.id));
    expect(noTagsTracks.map((t) => t.title)).toEqual(['First Song', 'Second Song']);
    expect(noTagsTracks.map((t) => t.number)).toEqual([1, 2]);

    // --- single-FILE cue produces virtual tracks, not one big-file track
    const cueAlbum = albumRow('Cue Album');
    const cueTracks = tracksOf(String(cueAlbum.id));
    expect(cueTracks).toHaveLength(3);
    expect(cueTracks.map((t) => t.title)).toEqual(['Cue One', 'Cue Two', 'Cue Three']);
    expect(cueTracks.map((t) => t.cue_start_ms)).toEqual([0, 1000, 2000]);
    const starts = cueTracks.map((t) => Number(t.cue_start_ms));
    expect(starts.every((v, i) => i === 0 || v > starts[i - 1]!)).toBe(true);
    expect(Number(cueTracks[0]!.cue_end_ms)).toBe(1000);
    expect(Number(cueTracks[2]!.cue_end_ms)).toBeGreaterThanOrEqual(2990);
    expect(cueTracks[0]!.path).toBe(cueFile());
    expect(cueTracks.map((t) => t.id)).toEqual(
      [1, 2, 3].map((n) => ids.localTrack(cueFile(), n)),
    );
    const bigFileTrack = db
      .prepare('SELECT id FROM tracks WHERE id = ?')
      .get(ids.localTrack(cueFile()));
    expect(bigFileTrack).toBeUndefined();

    // --- multi-FILE cue ignored
    const multiCueAlbum = albumRow('Multi Cue Album');
    const multiTracks = tracksOf(String(multiCueAlbum.id));
    expect(multiTracks.map((t) => t.title)).toEqual(['Tag A', 'Tag B']);
    expect(multiTracks.every((t) => t.cue_start_ms == null)).toBe(true);

    // --- Various Artists rule
    const va = albumRow('VA Album');
    expect(artistName(String(va.artist_id))).toBe('Various Artists');

    // --- embedded cover extracted into dataDir, never into the library
    const embedded = albumRow('Embedded Cover Album');
    const embeddedCoverPath = String(embedded.cover_path);
    expect(embeddedCoverPath.startsWith(join(dataDir, 'covers') + '/')).toBe(true);
    expect(embeddedCoverPath.endsWith('.png')).toBe(true);
    expect(existsSync(embeddedCoverPath)).toBe(true);
    expect(readdirSync(join(library, 'Embedded Cover Album'))).not.toContain('cover extracted');

    // --- FTS rows
    const albumFts = db
      .prepare("SELECT text FROM search_fts WHERE kind = 'album' AND ref_id = ?")
      .get(String(albumOne.id)) as { text: string } | undefined;
    expect(albumFts?.text).toContain('Album One');
    expect(albumFts?.text).toContain('Artist One');
    const trackFts = db
      .prepare("SELECT text FROM search_fts WHERE kind = 'track' AND ref_id = ?")
      .get(String(tracksOf(String(albumOne.id))[0]!.id)) as { text: string } | undefined;
    expect(trackFts?.text).toContain('First');
    expect(trackFts?.text).toContain('Artist One');
    const artistFts = db
      .prepare("SELECT text FROM search_fts WHERE kind = 'artist' AND ref_id = ?")
      .get(ids.artistByName('Artist One')) as { text: string } | undefined;
    expect(artistFts?.text).toBe('Artist One');
  });

  it('is incremental: a second scan changes nothing', async () => {
    const stats = await scanner.scan();
    expect(stats.filesSeen).toBe(15);
    expect(stats.changedFiles).toBe(0);
    expect(stats.changedAlbums).toBe(0);
    expect(stats.vanishedFiles).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('reparses a file when its mtime changes', async () => {
    const file = join(albumOneFolder(), '01 - First.flac');
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);

    const stats = await scanner.scan();
    expect(stats.changedFiles).toBe(1);
    expect(stats.changedAlbums).toBe(1);
    expect(stats.deletedTracks).toBe(0);
  });

  it('removes vanished tracks, then empty albums', async () => {
    const second = join(albumOneFolder(), '02 - Second.flac');
    unlinkSync(second);
    let stats = await scanner.scan();
    expect(stats.vanishedFiles).toBe(1);
    expect(stats.deletedTracks).toBe(1);
    expect(stats.deletedAlbums).toBe(0);

    const albumOne = albumRow('Album One');
    expect(tracksOf(String(albumOne.id))).toHaveLength(1);

    const first = join(albumOneFolder(), '01 - First.flac');
    unlinkSync(first);
    // The folder still exists (with folder.jpg), but the album has no tracks.
    stats = await scanner.scan();
    expect(stats.deletedTracks).toBe(1);
    expect(stats.deletedAlbums).toBe(1);

    const gone = db.prepare('SELECT id FROM albums WHERE title = ?').get('Album One');
    expect(gone).toBeUndefined();
    const fts = db
      .prepare("SELECT ref_id FROM search_fts WHERE kind = 'album' AND ref_id = ?")
      .get(String(albumOne.id));
    expect(fts).toBeUndefined();
  });

  it('never writes into the library root', () => {
    // The scanner only reads here; the extracted cover went to dataDir.
    chmodSync(library, 0o555);
    try {
      expect(readdirSync(library)).toContain('Embedded Cover Album');
    } finally {
      chmodSync(library, 0o755);
    }
  });
});
