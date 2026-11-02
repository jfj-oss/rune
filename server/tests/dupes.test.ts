import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type Db } from '../src/db/index.js';
import {
  albumNotHiddenSql,
  albumTitleKey,
  ensureDupesSchema,
  findDuplicates,
  getAlbumPrefs,
  hideAlbum,
  registerDupesRoutes,
  setPreferredOver,
  trackTitleKey,
  unhideAlbum,
  type DuplicateReport,
} from '../src/library/dupes.js';

// ---------------------------------------------------------------- seeding

interface AlbumSeed {
  id: string;
  title: string;
  artistId: string;
  year?: number | null;
  format?: string | null;
  cover?: string | null;
  folder?: string | null;
  mbRelease?: string | null;
  rg?: string | null;
  confidence?: number | null;
  addedAt?: number;
}

interface TrackSeed {
  id: string;
  albumId: string;
  title: string;
  number: number;
  disc?: number;
  durationMs: number;
  format?: string | null;
  sampleRate?: number | null;
  bitDepth?: number | null;
  bitrate?: number | null;
  mbid?: string | null;
  /** track_artists (in order); omitted = album artist only */
  artists?: string[];
}

function seedDb(artists: [string, string][], albums: AlbumSeed[], tracks: TrackSeed[]): Db {
  const db = openDb(':memory:');
  const artistStmt = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
  for (const [id, name] of artists) artistStmt.run(id, name);

  const albumStmt = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, format, folder_path, cover_path,
                         mb_release_id, mb_release_group_id, match_confidence, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of albums) {
    albumStmt.run(
      a.id,
      a.title,
      a.artistId,
      a.year ?? null,
      a.format ?? null,
      a.folder ?? null,
      a.cover ?? null,
      a.mbRelease ?? null,
      a.rg ?? null,
      a.confidence ?? null,
      a.addedAt ?? 1000,
    );
  }

  const trackStmt = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, format,
                         sample_rate, bit_depth, bitrate_kbps, mb_recording_id)
     VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const creditStmt = db.prepare(
    'INSERT INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)',
  );
  for (const t of tracks) {
    trackStmt.run(
      t.id,
      t.albumId,
      t.title,
      t.disc ?? 1,
      t.number,
      t.durationMs,
      t.format ?? null,
      t.sampleRate ?? null,
      t.bitDepth ?? null,
      t.bitrate ?? null,
      t.mbid ?? null,
    );
    (t.artists ?? []).forEach((artistId, i) => creditStmt.run(t.id, artistId, i));
  }
  return db;
}

/** `count` tracks named "Song N" on one album. */
function songs(albumId: string, prefix: string, count: number, duration = 200_000): TrackSeed[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `l:${albumId}:${prefix}${i + 1}`,
    albumId,
    title: `${prefix} ${i + 1}`,
    number: i + 1,
    durationMs: duration + i * 1000,
  }));
}

// ------------------------------------------------------------- qualities

describe('normalization', () => {
  it('folds artist names, edition/format suffixes and plurals in album titles', () => {
    expect(albumTitleKey('Essentials')).toBe('essential');
    expect(albumTitleKey('The Essential Billy Joel (2013) [24-96 HD FLAC]', 'Billy Joel')).toBe(
      'essential',
    );
    expect(albumTitleKey('The Bends')).toBe('bend');
    expect(albumTitleKey('Nevermind (30th Anniversary Super Deluxe)')).toBe('nevermind');
    // self-titled albums key on their own title, not an empty string
    expect(albumTitleKey('ABBA', 'ABBA')).toBe('abba');
  });

  it('drops only edition-noise parentheticals from track titles', () => {
    expect(trackTitleKey('The Entertainer (Album Version)')).toBe('the entertainer');
    expect(trackTitleKey('Song (Remastered 2011)')).toBe('song');
    expect(trackTitleKey('Song (Live)')).toBe('song live');
    expect(trackTitleKey('2+2=5')).toBe('2 2 5');
  });
});

// --------------------------------------------------------- album grouping

describe('album duplicates', () => {
  it('groups albums sharing a MusicBrainz release group and recommends the best rip', () => {
    const db = seedDb(
      [['ar:bj', 'Billy Joel']],
      [
        {
          id: 'la:mp3',
          title: 'Essentials',
          artistId: 'ar:bj',
          format: 'MP3 320',
          folder: '/mnt/music/Billy Joel - Essentials (Mp3 320kbps)',
          rg: 'rg-1',
          addedAt: 3000,
        },
        {
          id: 'la:flac16',
          title: 'Essentials (Deluxe)',
          artistId: 'ar:bj',
          format: 'FLAC 16/44.1',
          folder: '/mnt/music/Billy Joel - Essentials Deluxe FLAC',
          rg: 'rg-1',
          addedAt: 2000,
        },
        {
          id: 'la:flac24',
          title: 'The Essential Billy Joel',
          artistId: 'ar:bj',
          format: 'FLAC 24/96',
          folder: '/mnt/music/Billy Joel - The Essential Billy Joel (2013) [24-96 HD FLAC]',
          cover: '/covers/bj.jpg',
          mbRelease: 'rel-1',
          rg: 'rg-1',
          confidence: 0.96,
          addedAt: 1000,
        },
      ],
      [
        ...songs('la:mp3', 'Song', 5).map((t) => ({
          ...t,
          format: 'mp3',
          bitrate: 320,
        })),
        ...songs('la:flac16', 'Song', 5).map((t) => ({
          ...t,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
        })),
        ...songs('la:flac24', 'Song', 6).map((t) => ({
          ...t,
          format: 'flac',
          sampleRate: 96_000,
          bitDepth: 24,
        })),
      ],
    );

    const report = findDuplicates(db);
    expect(report.groups).toHaveLength(1);
    const group = report.groups[0]!;
    expect(group.kind).toBe('release-group');
    expect(group.match.releaseGroupIds).toEqual(['rg-1']);
    expect(group.albums.map((a) => a.albumId)).toEqual(['la:flac24', 'la:flac16', 'la:mp3']);
    expect(group.bestAlbumId).toBe('la:flac24');
    expect(group.albums[0]!.recommended).toBe(true);
    expect(group.albums[0]!.folderName).toBe(
      'Billy Joel - The Essential Billy Joel (2013) [24-96 HD FLAC]',
    );
    expect(group.albums[0]!.trackCount).toBe(6);
    expect(group.albums[0]!.lossless).toBe(true);
    expect(group.albums[0]!.bitDepth).toBe(24);
    expect(group.albums[0]!.sampleRate).toBe(96_000);
    expect(group.albums[0]!.hasCover).toBe(true);
    expect(group.albums[0]!.matched).toBe(true);
    expect(group.reason).toContain('Same MusicBrainz release group rg-1');
    expect(group.reason).toContain('24-bit vs 16-bit');
    expect(group.reason).toContain('96 kHz vs 44.1 kHz');
    expect(group.reason).toContain('1 more track');
  });

  it('groups same-artist albums by normalized title + >=70% track overlap', () => {
    const db = seedDb(
      [['ar:bj', 'Billy Joel']],
      [
        {
          id: 'la:mp3',
          title: 'Essentials',
          artistId: 'ar:bj',
          format: 'MP3 320',
          folder: '/mnt/music/Billy Joel - Essentials (Mp3 320kbps) [PMEDIA]',
        },
        {
          id: 'la:flac',
          title: 'The Essential Billy Joel (2013) [24-96 HD FLAC]',
          artistId: 'ar:bj',
          format: 'FLAC 24/96',
          folder: '/mnt/music/Billy Joel - The Essential Billy Joel (2013) [24-96 HD FLAC]',
          cover: '/covers/bj.jpg',
          mbRelease: 'rel-1',
        },
      ],
      [
        ...songs('la:mp3', 'Song', 5).map((t) => ({ ...t, format: 'mp3', bitrate: 320 })),
        ...songs('la:flac', 'Song', 5).map((t, i) => ({
          ...t,
          // same recordings, a couple of seconds apart
          durationMs: t.durationMs + 2000,
          format: 'flac',
          sampleRate: 96_000,
          bitDepth: 24,
        })),
      ],
    );

    const report = findDuplicates(db);
    expect(report.groups).toHaveLength(1);
    const group = report.groups[0]!;
    expect(group.kind).toBe('same-title');
    expect(group.title).toBe('The Essential Billy Joel (2013) [24-96 HD FLAC]');
    expect(group.match.titleKeys).toEqual(['essential']);
    expect(group.match.trackOverlap).toBe(1);
    expect(group.bestAlbumId).toBe('la:flac');
    expect(group.reason).toContain('Same normalized title "essential"');
    expect(group.reason).toContain('100% track overlap');
    expect(group.reason).toContain('lossless vs lossy');
  });

  it('does not group albums below the 70% overlap threshold', () => {
    const albumTracks = ['Planet Telex', 'The Bends', 'High and Dry', 'Fake Plastic Trees', 'Bones'];
    const db = seedDb(
      [['ar:rh', 'Radiohead']],
      [
        {
          id: 'la:album',
          title: 'The Bends',
          artistId: 'ar:rh',
          format: 'FLAC 16/44.1',
        },
        {
          id: 'la:ep',
          title: 'The Bends',
          artistId: 'ar:rh',
          format: 'FLAC 16/44.1',
        },
      ],
      [
        ...albumTracks.map((title, i): TrackSeed => ({
          id: `l:album:${i + 1}`,
          albumId: 'la:album',
          title,
          number: i + 1,
          durationMs: 200_000 + i * 1000,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
        })),
        // 2 of 3 match -> 66.7%, below the threshold
        { id: 'l:ep:1', albumId: 'la:ep', title: 'Planet Telex', number: 1, durationMs: 200_000, format: 'flac', sampleRate: 44_100, bitDepth: 16 },
        { id: 'l:ep:2', albumId: 'la:ep', title: 'Bones', number: 2, durationMs: 204_000, format: 'flac', sampleRate: 44_100, bitDepth: 16 },
        { id: 'l:ep:3', albumId: 'la:ep', title: 'My Iron Lung', number: 3, durationMs: 280_000, format: 'flac', sampleRate: 44_100, bitDepth: 16 },
      ],
    );

    expect(findDuplicates(db).groups).toEqual([]);
  });

  it('does not group same-titled albums by different artists', () => {
    const db = seedDb(
      [
        ['ar:a', 'Artist A'],
        ['ar:b', 'Artist B'],
      ],
      [
        { id: 'la:a', title: 'Greatest Hits', artistId: 'ar:a' },
        { id: 'la:b', title: 'Greatest Hits', artistId: 'ar:b' },
      ],
      [
        ...songs('la:a', 'Song', 3),
        ...songs('la:b', 'Song', 3),
      ],
    );
    expect(findDuplicates(db).groups).toEqual([]);
  });

  it('prefers the more complete lossless rip, not the one with a higher FLAC bitrate', () => {
    const db = seedDb(
      [['ar:x', 'Artist X']],
      [
        { id: 'la:short', title: 'Album', artistId: 'ar:x', format: 'FLAC 16/44.1', rg: 'rg-x' },
        { id: 'la:full', title: 'Album (Expanded)', artistId: 'ar:x', format: 'FLAC 16/44.1', rg: 'rg-x' },
      ],
      [
        ...songs('la:short', 'Song', 3).map((t) => ({
          ...t,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
          bitrate: 1400,
        })),
        ...songs('la:full', 'Song', 5).map((t) => ({
          ...t,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
          bitrate: 900,
        })),
      ],
    );
    const group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:full');
    expect(group.reason).toContain('2 more tracks');
  });

  it('prefers lossless even when the lossy rip has more tracks', () => {
    const db = seedDb(
      [['ar:x', 'Artist X']],
      [
        {
          id: 'la:flac',
          title: 'Album',
          artistId: 'ar:x',
          format: 'FLAC 16/44.1',
          rg: 'rg-x',
        },
        {
          id: 'la:mp3',
          title: 'Album (Deluxe)',
          artistId: 'ar:x',
          format: 'MP3 320',
          rg: 'rg-x',
        },
      ],
      [
        ...songs('la:flac', 'Song', 5).map((t) => ({
          ...t,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
        })),
        ...songs('la:mp3', 'Song', 10).map((t) => ({ ...t, format: 'mp3', bitrate: 320 })),
      ],
    );
    const group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:flac');
    expect(group.reason).toContain('lossless vs lossy');
  });
});

// --------------------------------------------------------- track grouping

describe('track duplicates', () => {
  it('finds the same song on a compilation and its album (title + artist + duration)', () => {
    const db = seedDb(
      [
        ['ar:x', 'Artist X'],
        ['ar:v', 'Various Artists'],
      ],
      [
        { id: 'la:comp', title: 'Now That Is Music', artistId: 'ar:v' },
        { id: 'la:studio', title: 'Debut', artistId: 'ar:x' },
      ],
      [
        {
          id: 'l:comp:1',
          albumId: 'la:comp',
          title: 'Song One',
          number: 1,
          durationMs: 200_000,
          format: 'mp3',
          bitrate: 320,
          artists: ['ar:x'],
        },
        {
          id: 'l:studio:1',
          albumId: 'la:studio',
          title: 'Song One (Album Version)',
          number: 4,
          durationMs: 201_500,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
          artists: ['ar:x'],
        },
        // only on the studio album -> not a duplicate
        {
          id: 'l:studio:2',
          albumId: 'la:studio',
          title: 'Song Two',
          number: 5,
          durationMs: 210_000,
          format: 'flac',
          sampleRate: 44_100,
          bitDepth: 16,
          artists: ['ar:x'],
        },
      ],
    );

    const report = findDuplicates(db);
    expect(report.trackGroups).toHaveLength(1);
    const group = report.trackGroups[0]!;
    expect(group.match).toBe('title-duration');
    expect(group.title).toBe('Song One');
    expect(group.artist).toBe('Artist X');
    expect(group.albumIds.sort()).toEqual(['la:comp', 'la:studio']);
    expect(group.tracks.map((t) => t.trackId).sort()).toEqual(['l:comp:1', 'l:studio:1']);
    expect(group.reason).toContain('Same title "Song One"');
    expect(group.tracks[0]).not.toHaveProperty('path');
  });

  it('uses a matching recording mbid to bridge a duration difference', () => {
    const db = seedDb(
      [['ar:x', 'Artist X']],
      [
        { id: 'la:a', title: 'First', artistId: 'ar:x' },
        { id: 'la:b', title: 'Second', artistId: 'ar:x' },
      ],
      [
        {
          id: 'l:a:1',
          albumId: 'la:a',
          title: 'Hidden Track (Album Version)',
          number: 1,
          durationMs: 180_000,
          mbid: 'rec-1',
        },
        {
          id: 'l:b:1',
          albumId: 'la:b',
          title: 'Hidden Track',
          number: 1,
          durationMs: 190_000,
          mbid: 'rec-1',
        },
      ],
    );
    const group = findDuplicates(db).trackGroups[0]!;
    expect(group.match).toBe('recording');
    expect(group.mbRecordingId).toBe('rec-1');
    expect(group.tracks.map((t) => t.trackId).sort()).toEqual(['l:a:1', 'l:b:1']);
    expect(group.reason).toContain('rec-1');
  });

  it('bridges an mbid across a parenthetical subtitle', () => {
    const db = seedDb(
      [['ar:rh', 'Radiohead']],
      [
        { id: 'la:a', title: 'Hail to the Thief', artistId: 'ar:rh' },
        { id: 'la:b', title: 'The Best Of', artistId: 'ar:rh' },
      ],
      [
        { id: 'l:a:1', albumId: 'la:a', title: '2 + 2 = 5. (The Lukewarm.)', number: 1, durationMs: 199_413, mbid: 'rec-2' },
        { id: 'l:b:1', albumId: 'la:b', title: '2+2=5', number: 1, durationMs: 198_693, mbid: 'rec-2' },
      ],
    );
    const group = findDuplicates(db).trackGroups[0]!;
    expect(group.match).toBe('recording');
    expect(group.title).toBe('2+2=5');
  });

  it('does not bridge an mbid between a studio and live take or similar titles', () => {
    const db = seedDb(
      [['ar:rh', 'Radiohead']],
      [
        { id: 'la:a', title: 'A', artistId: 'ar:rh' },
        { id: 'la:b', title: 'B', artistId: 'ar:rh' },
        { id: 'la:c', title: 'C', artistId: 'ar:rh' },
        { id: 'la:d', title: 'D', artistId: 'ar:rh' },
      ],
      [
        { id: 'l:a:1', albumId: 'la:a', title: 'Same Song', number: 1, durationMs: 200_000, mbid: 'rec-live' },
        { id: 'l:b:1', albumId: 'la:b', title: 'Same Song (Live)', number: 1, durationMs: 200_000, mbid: 'rec-live' },
        { id: 'l:c:1', albumId: 'la:c', title: '4 Minute Warning', number: 1, durationMs: 246_267, mbid: 'rec-short' },
        { id: 'l:d:1', albumId: 'la:d', title: 'Minute Warning', number: 1, durationMs: 245_347, mbid: 'rec-short' },
      ],
    );
    expect(findDuplicates(db).trackGroups).toEqual([]);
  });

  it('ignores a colliding recording mbid when the titles are different songs', () => {
    const db = seedDb(
      [['ar:bj', 'Billy Joel']],
      [
        { id: 'la:a', title: 'Essentials', artistId: 'ar:bj' },
        { id: 'la:b', title: 'The Essential Billy Joel', artistId: 'ar:bj' },
      ],
      [
        { id: 'l:a:1', albumId: 'la:a', title: 'Piano Man', number: 1, durationMs: 339_000, mbid: 'bad-mbid' },
        { id: 'l:b:1', albumId: 'la:b', title: 'Just the Way You Are', number: 1, durationMs: 290_000, mbid: 'bad-mbid' },
      ],
    );
    expect(findDuplicates(db).trackGroups).toEqual([]);
  });

  it('does not list a repeated track inside one album as a compilation duplicate', () => {
    const db = seedDb(
      [['ar:x', 'Artist X']],
      [{ id: 'la:only', title: 'Only', artistId: 'ar:x' }],
      [
        { id: 'l:only:1', albumId: 'la:only', title: 'Song', number: 1, durationMs: 200_000 },
        { id: 'l:only:2', albumId: 'la:only', title: 'Song', number: 2, durationMs: 200_000 },
      ],
    );
    expect(findDuplicates(db).trackGroups).toEqual([]);
  });
});

// ---------------------------------------------------------------- prefs

function twoAlbumGroup(): Db {
  return seedDb(
    [['ar:x', 'Artist X']],
    [
      { id: 'la:mp3', title: 'Album', artistId: 'ar:x', format: 'MP3 320', folder: '/m/a mp3', rg: 'rg-1' },
      { id: 'la:flac', title: 'Album (Deluxe)', artistId: 'ar:x', format: 'FLAC 24/96', folder: '/m/a flac', rg: 'rg-1', mbRelease: 'r1' },
    ],
    [
      ...songs('la:mp3', 'Song', 3).map((t) => ({ ...t, format: 'mp3', bitrate: 320 })),
      ...songs('la:flac', 'Song', 3).map((t) => ({ ...t, format: 'flac', sampleRate: 96_000, bitDepth: 24 })),
    ],
  );
}

describe('album preferences', () => {
  it('is idempotent and creates album_prefs after schema.sql', () => {
    const db = seedDb(
      [['ar:x', 'Artist X']],
      [{ id: 'la:one', title: 'One', artistId: 'ar:x' }],
      [],
    );
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'album_prefs'")
      .get();
    expect(before).toBeUndefined();
    ensureDupesSchema(db);
    ensureDupesSchema(db);
    hideAlbum(db, 'la:one');
    hideAlbum(db, 'la:one');
    ensureDupesSchema(db);
    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'album_prefs'")
      .get() as { name: string };
    expect(after.name).toBe('album_prefs');
    expect(getAlbumPrefs(db, 'la:one')).toEqual({ albumId: 'la:one', hidden: true });
  });

  it('hide/unhide persist without touching albums or tracks', () => {
    const db = twoAlbumGroup();
    const albumCount = (db.prepare('SELECT count(*) n FROM albums').get() as { n: number }).n;
    const trackCount = (db.prepare('SELECT count(*) n FROM tracks').get() as { n: number }).n;

    expect(hideAlbum(db, 'la:flac')).toEqual({ albumId: 'la:flac', hidden: true });
    expect(getAlbumPrefs(db, 'la:flac')).toEqual({ albumId: 'la:flac', hidden: true });
    const rows = db
      .prepare(
        `SELECT id FROM albums a WHERE ${albumNotHiddenSql(db, 'a')} ORDER BY id`,
      )
      .all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['la:mp3']);
    expect(() => albumNotHiddenSql(db, 'a; drop table albums')).toThrow(/invalid SQL alias/);

    expect(unhideAlbum(db, 'la:flac')).toEqual({ albumId: 'la:flac', hidden: false });
    expect(
      (db.prepare('SELECT count(*) n FROM albums').get() as { n: number }).n,
    ).toBe(albumCount);
    expect(
      (db.prepare('SELECT count(*) n FROM tracks').get() as { n: number }).n,
    ).toBe(trackCount);
  });

  it('never recommends a hidden album while a visible one exists', () => {
    const db = twoAlbumGroup();
    let group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:flac');

    hideAlbum(db, 'la:flac');
    group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:mp3');
    expect(group.albums.find((a) => a.albumId === 'la:flac')!.hidden).toBe(true);
    expect(group.reason).not.toContain('all versions are hidden');

    unhideAlbum(db, 'la:flac');
    expect(findDuplicates(db).groups[0]!.bestAlbumId).toBe('la:flac');
  });

  it('honours preferred_over ahead of quality and can clear it', () => {
    const db = twoAlbumGroup();
    expect(setPreferredOver(db, 'la:mp3', 'la:flac')).toEqual({
      albumId: 'la:mp3',
      hidden: false,
      preferredOver: 'la:flac',
    });
    let group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:mp3');
    expect(group.reason).toContain('user preference');

    // hiding the preferred album still demotes it
    hideAlbum(db, 'la:mp3');
    expect(findDuplicates(db).groups[0]!.bestAlbumId).toBe('la:flac');

    // unhide + clear the preference -> quality wins again
    unhideAlbum(db, 'la:mp3');
    setPreferredOver(db, 'la:mp3', null);
    group = findDuplicates(db).groups[0]!;
    expect(group.bestAlbumId).toBe('la:flac');
    expect(() => setPreferredOver(db, 'la:mp3', 'la:mp3')).toThrow(/itself/);
  });
});

// ---------------------------------------------------------------- routes

describe('routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function makeApp(db: Db): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    await app.register(async (r) => registerDupesRoutes(r, db), { prefix: '/api' });
    await app.ready();
    apps.push(app);
    return app;
  }

  it('serves duplicates and hides/unhides albums', async () => {
    const db = twoAlbumGroup();
    const app = await makeApp(db);

    const res = await app.inject({ method: 'GET', url: '/api/library/duplicates' });
    expect(res.statusCode).toBe(200);
    const report = res.json() as DuplicateReport;
    expect(report.albumsScanned).toBe(2);
    expect(report.tracksScanned).toBe(6);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.bestAlbumId).toBe('la:flac');
    expect(report.groups[0]!.albums[0]).toMatchObject({
      albumId: 'la:flac',
      folderName: 'a flac',
      format: 'FLAC 24/96',
      trackCount: 3,
      lossless: true,
    });

    const hide = await app.inject({ method: 'POST', url: '/api/albums/la:flac/hide' });
    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toEqual({
      albumId: 'la:flac',
      hidden: true,
      prefs: { albumId: 'la:flac', hidden: true },
    });

    const after = (await app.inject({ method: 'GET', url: '/api/library/duplicates' })).json() as DuplicateReport;
    expect(after.groups[0]!.bestAlbumId).toBe('la:mp3');

    const unhide = await app.inject({ method: 'DELETE', url: '/api/albums/la:flac/hide' });
    expect(unhide.statusCode).toBe(200);
    expect(unhide.json()).toEqual({
      albumId: 'la:flac',
      hidden: false,
      prefs: { albumId: 'la:flac', hidden: false },
    });

    const missingHide = await app.inject({ method: 'POST', url: '/api/albums/la:nope/hide' });
    expect(missingHide.statusCode).toBe(404);
    const missingUnhide = await app.inject({ method: 'DELETE', url: '/api/albums/la:nope/hide' });
    expect(missingUnhide.statusCode).toBe(404);
  });
});
