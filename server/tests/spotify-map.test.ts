import { describe, expect, it } from 'vitest';
import { ids, openDb } from '../src/db/index.js';
import { ensureSpotifySchema } from '../src/spotify/auth.js';
import {
  ArtistResolver,
  largestImage,
  mapAlbum,
  mapArtist,
  mapTrack,
  spotifyAlbumId,
  spotifyArtistId,
  spotifyTrackId,
  syncSavedAlbums,
  yearFromReleaseDate,
} from '../src/spotify/map.js';
import {
  ABBEY_COVER,
  BEATLES,
  paging,
  sampleAlbum,
  sampleTrack,
} from './spotify-helpers.js';

describe('Spotify → shared mapping', () => {
  it('maps an album with sp:/ar:sp: ids and Spotify cover URL', () => {
    const album = mapAlbum(sampleAlbum(), { addedAt: 111 });

    expect(album.id).toBe('sp:abbey');
    expect(album.source).toBe('spotify');
    expect(album.title).toBe('Abbey Road');
    expect(album.artist).toEqual({ id: 'ar:sp:beatles-sp', name: 'The Beatles' });
    expect(album.year).toBe(1969);
    expect(album.releaseDate).toBe('1969-09-26');
    expect(album.label).toBe('Apple');
    expect(album.genres).toEqual(['rock']);
    expect(album.coverUrl).toBe(ABBEY_COVER);
    expect(album.format).toBe('Spotify');
    expect(album.addedAt).toBe(111);
    expect(album.credits).toEqual([]);

    expect(album.tracks).toHaveLength(2);
    const first = album.tracks[0]!;
    expect(first.id).toBe('sp:t1');
    expect(first.albumId).toBe('sp:abbey');
    expect(first.source).toBe('spotify');
    expect(first.title).toBe('Come Together');
    expect(first.disc).toBe(1);
    expect(first.number).toBe(1);
    expect(first.durationMs).toBe(259001);
    expect(first.spotifyUri).toBe('spotify:track:t1');
    expect(first.artists).toEqual([{ id: 'ar:sp:beatles-sp', name: 'The Beatles' }]);
  });

  it('picks the largest image regardless of ordering', () => {
    expect(
      largestImage([
        { url: 'small', width: 64, height: 64 },
        { url: 'big', width: 640, height: 640 },
        { url: 'medium', width: 300, height: 300 },
      ]),
    ).toBe('big');
    expect(
      largestImage([
        { url: 'big', width: 640, height: 640 },
        { url: 'small', width: 64, height: 64 },
      ]),
    ).toBe('big');
    expect(largestImage([])).toBeUndefined();
    expect(largestImage(undefined)).toBeUndefined();
  });

  it('maps artists and derives release years', () => {
    const artist = mapArtist(BEATLES);
    expect(artist.id).toBe('ar:sp:beatles-sp');
    expect(artist.name).toBe('The Beatles');
    expect(artist.imageUrl).toBe('http://img.example/beatles-640.jpg');
    expect(artist.albums).toEqual([]);
    expect(artist.appearsOn).toEqual([]);

    expect(yearFromReleaseDate('1969-09-26')).toBe(1969);
    expect(yearFromReleaseDate('1969-09')).toBe(1969);
    expect(yearFromReleaseDate('1969')).toBe(1969);
    expect(yearFromReleaseDate(undefined)).toBeUndefined();
  });

  it('keeps ids stable and handles null track ids', () => {
    expect(spotifyAlbumId('x')).toBe('sp:x');
    expect(spotifyTrackId('x')).toBe('sp:x');
    expect(spotifyArtistId('x')).toBe('ar:sp:x');

    const t = mapTrack({ ...sampleTrack(''), id: null });
    expect(t.id).toMatch(/^sp:local:[0-9a-f]{16}$/);
    expect(mapTrack({ ...sampleTrack(''), id: null }).id).toBe(t.id);
  });
});

describe('artist merge rule', () => {
  it('reuses a same-named local artist id and records the Spotify id', () => {
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    const localId = ids.artistByName('Beatles');
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(localId, 'The Beatles');

    const ref = new ArtistResolver(db).resolve({ id: 'beatles-sp', name: 'Beatles' });
    expect(ref.id).toBe(localId);
    const row = db.prepare('SELECT spotify_id FROM artists WHERE id = ?').get(localId) as {
      spotify_id: string | null;
    };
    expect(row.spotify_id).toBe('beatles-sp');

    // A fresh resolver uses the persisted mapping.
    expect(new ArtistResolver(db).resolve({ id: 'beatles-sp', name: 'The Beatles' }).id).toBe(localId);
  });

  it('creates ar:sp:<id> when no local artist matches', () => {
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    const resolver = new ArtistResolver(db);
    expect(resolver.resolve({ id: 'new-sp', name: 'Brand New' }).id).toBe('ar:sp:new-sp');
    expect(db.prepare('SELECT spotify_id FROM artists WHERE id = ?').get('ar:sp:new-sp')).toEqual({
      spotify_id: 'new-sp',
    });
  });

  it('does not merge two different Spotify artists with the same name', () => {
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    const resolver = new ArtistResolver(db);
    const a = resolver.resolve({ id: 'sp-1', name: 'Namesakes' });
    const b = resolver.resolve({ id: 'sp-2', name: 'Namesakes' });
    expect(a.id).toBe('ar:sp:sp-1');
    expect(b.id).toBe('ar:sp:sp-2');
  });
});

describe('syncSavedAlbums', () => {
  function freshDb() {
    const db = openDb(':memory:');
    ensureSpotifySchema(db);
    return db;
  }

  it('upserts saved albums, tracks, artists and search_fts', async () => {
    const db = freshDb();
    const second = sampleAlbum({
      id: 'letitbe',
      name: 'Let It Be',
      images: [{ url: 'http://img.example/let-640.jpg', width: 600, height: 600 }],
      tracks: paging([sampleTrack('t10', 1, 'Two Of Us')]),
    });
    let albumTracksCalls = 0;
    const source = {
      allSavedAlbums: async () => [
        { added_at: '2024-02-01T00:00:00Z', album: sampleAlbum() },
        { added_at: '2024-03-01T00:00:00Z', album: second },
      ],
      allAlbumTracks: async () => {
        albumTracksCalls++;
        return [];
      },
    };

    const result = await syncSavedAlbums(source, db);
    expect(result).toEqual({ albums: 2, tracks: 3, artists: 1, removed: 0 });
    expect(albumTracksCalls).toBe(0);

    const albums = db.prepare(`SELECT * FROM albums WHERE source = 'spotify' ORDER BY id`).all() as {
      id: string;
      artist_id: string;
      cover_path: string;
      added_at: number;
      format: string;
      spotify_id: string;
    }[];
    expect(albums.map((a) => a.id)).toEqual(['sp:abbey', 'sp:letitbe']);
    expect(albums[0]?.artist_id).toBe('ar:sp:beatles-sp');
    expect(albums[0]?.cover_path).toBe(ABBEY_COVER);
    expect(albums[0]?.format).toBe('Spotify');
    expect(albums[0]?.spotify_id).toBe('abbey');
    expect(albums[0]?.added_at).toBe(Date.parse('2024-02-01T00:00:00Z'));

    expect(count(db, 'tracks')).toBe(3);
    expect(count(db, 'track_artists')).toBe(3);
    expect(count(db, 'artists')).toBe(1);
    expect(count(db, 'search_fts')).toBe(6); // 2 albums + 3 tracks + 1 artist

    const ftsHit = db
      .prepare(`SELECT ref_id FROM search_fts WHERE search_fts MATCH 'abbey' ORDER BY kind`)
      .all() as { ref_id: string }[];
    expect(ftsHit.map((r) => r.ref_id)).toContain('sp:abbey');

    const track = db.prepare('SELECT * FROM tracks WHERE id = ?').get('sp:t1') as {
      album_id: string;
      title: string;
      disc: number;
      number: number;
      duration_ms: number;
      spotify_uri: string;
    };
    expect(track).toMatchObject({
      album_id: 'sp:abbey',
      title: 'Come Together',
      disc: 1,
      number: 1,
      duration_ms: 259001,
      spotify_uri: 'spotify:track:t1',
    });
  });

  it('removes albums no longer saved and cascades their tracks/fts, leaving local albums', async () => {
    const db = freshDb();
    // Pre-existing local album must survive the Spotify sync.
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:local', 'Local Artist');
    db.prepare(
      `INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:local', 'local', 'Local', 'ar:local', 1)`,
    ).run();

    const keep = { added_at: '2024-02-01T00:00:00Z', album: sampleAlbum() };
    const dropAlbum = sampleAlbum({
      id: 'letitbe',
      name: 'Let It Be',
      tracks: paging([sampleTrack('t10', 1, 'Two Of Us')]),
    });
    const first = await syncSavedAlbums(
      { allSavedAlbums: async () => [keep, { added_at: '2024-03-01T00:00:00Z', album: dropAlbum }], allAlbumTracks: async () => [] },
      db,
    );
    expect(first).toEqual({ albums: 2, tracks: 3, artists: 1, removed: 0 });

    const second = await syncSavedAlbums(
      { allSavedAlbums: async () => [keep], allAlbumTracks: async () => [] },
      db,
    );
    expect(second.removed).toBe(1);
    expect(db.prepare('SELECT id FROM albums ORDER BY id').all()).toEqual([
      { id: 'la:local' },
      { id: 'sp:abbey' },
    ]);
    expect(db.prepare('SELECT id FROM tracks ORDER BY id').all()).toEqual([{ id: 'sp:t1' }, { id: 'sp:t2' }]);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM search_fts WHERE ref_id IN ('sp:letitbe', 'sp:t10')`).get(),
    ).toEqual({ n: 0 });
    // 1 kept Spotify album + its 2 tracks + 1 artist remain indexed.
    expect(count(db, 'search_fts')).toBe(4);
  });

  it('fetches remaining album tracks when the saved-album payload is paged', async () => {
    const db = freshDb();
    const partial = sampleAlbum({
      tracks: paging([sampleTrack('t1')], { total: 2, next: 'http://api.test/next' }),
    });
    let fetched = 0;
    const result = await syncSavedAlbums(
      {
        allSavedAlbums: async () => [{ added_at: '2024-01-01T00:00:00Z', album: partial }],
        allAlbumTracks: async (id) => {
          fetched++;
          expect(id).toBe('abbey');
          return [sampleTrack('t1'), sampleTrack('t2', 2, 'Something')];
        },
      },
      db,
    );
    expect(fetched).toBe(1);
    expect(result.tracks).toBe(2);
    expect(count(db, 'tracks')).toBe(2);
  });

  it('merges a synced Spotify album onto an existing local artist', async () => {
    const db = freshDb();
    const localId = ids.artistByName('The Beatles');
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(localId, 'The Beatles');

    const result = await syncSavedAlbums(
      { allSavedAlbums: async () => [{ added_at: '2024-01-01T00:00:00Z', album: sampleAlbum() }], allAlbumTracks: async () => [] },
      db,
    );
    expect(result.artists).toBe(1);
    const album = db.prepare('SELECT artist_id FROM albums WHERE id = ?').get('sp:abbey') as { artist_id: string };
    expect(album.artist_id).toBe(localId);
    const trackArtists = db.prepare('SELECT DISTINCT artist_id FROM track_artists').all() as { artist_id: string }[];
    expect(trackArtists).toEqual([{ artist_id: localId }]);
    expect(db.prepare('SELECT spotify_id FROM artists WHERE id = ?').get(localId)).toEqual({
      spotify_id: 'beatles-sp',
    });
  });
});

function count(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
