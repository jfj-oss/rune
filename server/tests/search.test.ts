import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { ensureHistorySchema } from '../src/history/index.js';
import {
  createSearch,
  ensureSearchSchema,
  registerSearchRoutes,
  type Search,
} from '../src/search/index.js';

// ---------------------------------------------------------------- fixtures

interface Seed {
  artists: [string, string][];
  albums: {
    id: string;
    title: string;
    artistId: string;
    year?: number;
    genres?: string[];
    source?: 'local' | 'spotify';
    format?: string;
  }[];
  tracks: { id: string; albumId: string; title: string; n: number; durationMs?: number }[];
  credits: { albumId: string; artistId: string; role: string }[];
  plays?: { trackId: string; albumId: string; times: number }[];
}

function seed(db: Db, s: Seed): void {
  const artist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
  for (const [id, name] of s.artists) artist.run(id, name);
  const album = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, genres, format, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [i, a] of s.albums.entries()) {
    album.run(
      a.id,
      a.source ?? 'local',
      a.title,
      a.artistId,
      a.year ?? null,
      JSON.stringify(a.genres ?? []),
      a.format ?? 'FLAC',
      1_700_000_000_000 + i * 1000,
    );
  }
  const track = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path, format)
     VALUES (?, ?, 'local', ?, 1, ?, ?, ?, 'FLAC')`,
  );
  for (const t of s.tracks) track.run(t.id, t.albumId, t.title, t.n, t.durationMs ?? 180_000, `/music/${t.id}.flac`);
  const credit = db.prepare('INSERT INTO credits (album_id, artist_id, role) VALUES (?, ?, ?)');
  for (const c of s.credits) credit.run(c.albumId, c.artistId, c.role);
  if (s.plays?.length) {
    ensureHistorySchema(db);
    const play = db.prepare(
      `INSERT INTO plays (track_id, album_id, zone, started_at, played_ms, completed)
       VALUES (?, ?, 'pc', ?, 200000, 1)`,
    );
    let at = 1_700_000_000_000;
    for (const p of s.plays) for (let i = 0; i < p.times; i++) play.run(p.trackId, p.albumId, at++);
  }
}

const LIBRARY: Seed = {
  artists: [
    ['ar:bjork', 'Björk'],
    ['ar:acdc', 'AC/DC'],
    ['ar:beatles', 'The Beatles'],
    ['ar:sp', 'The Smashing Pumpkins'],
    ['ar:nirvana', 'Nirvana'],
    ['ar:daft', 'Daft Punk'],
    ['ar:rafferty', 'Gerry Rafferty'],
    ['ar:blue', 'Blue Öyster Cult'],
    ['ar:alice', 'Alice in Chains'],
    ['ar:toby', 'Toby Wright'],
    ['ar:flood', 'Flood'],
    ['ar:abba', 'ABBA'],
    ['ar:queen', 'Queen'],
    ['ar:metallica', 'Metallica'],
  ],
  albums: [
    { id: 'la:debut', title: 'Debut', artistId: 'ar:bjork', year: 1993, genres: ['Electronic', 'Pop'] },
    { id: 'la:post', title: 'Post', artistId: 'ar:bjork', year: 1995 },
    { id: 'la:homogenic', title: 'Homogenic', artistId: 'ar:bjork', year: 1997 },
    { id: 'la:backinblack', title: 'Back in Black', artistId: 'ar:acdc', year: 1980, genres: ['Hard Rock'] },
    { id: 'la:abbeyroad', title: 'Abbey Road', artistId: 'ar:beatles', year: 1969 },
    { id: 'la:revolver', title: 'Revolver', artistId: 'ar:beatles', year: 1966 },
    {
      id: 'la:mellon',
      title: 'Mellon Collie and the Infinite Sadness',
      artistId: 'ar:sp',
      year: 1995,
      genres: ['Alternative Rock'],
    },
    { id: 'la:nevermind', title: 'Nevermind', artistId: 'ar:nirvana', year: 1991, genres: ['Grunge'] },
    { id: 'la:discovery', title: 'Discovery', artistId: 'ar:daft', year: 2001, genres: ['Electronic'] },
    { id: 'la:citytocity', title: 'City to City', artistId: 'ar:rafferty', year: 1978 },
    { id: 'la:agents', title: 'Agents of Fortune', artistId: 'ar:blue', year: 1976, genres: ['Rock'] },
    { id: 'la:jar', title: 'Jar of Flies', artistId: 'ar:alice', year: 1994, genres: ['Grunge'] },
    { id: 'la:greatest1', title: 'Greatest Hits', artistId: 'ar:abba', year: 1992 },
    { id: 'la:greatest2', title: 'Greatest Hits', artistId: 'ar:queen', year: 1981 },
    { id: 'la:puppets', title: 'Master of Puppets', artistId: 'ar:metallica', year: 1986, genres: ['Thrash Metal'] },
    {
      id: 'la:ram',
      title: 'Random Access Memories',
      artistId: 'ar:daft',
      year: 2013,
      source: 'spotify',
      genres: ['Electronic'],
    },
  ],
  tracks: [
    { id: 'l:human', albumId: 'la:debut', title: 'Human Behaviour', n: 1 },
    { id: 'l:venus', albumId: 'la:debut', title: 'Venus as a Boy', n: 2 },
    { id: 'l:army', albumId: 'la:post', title: 'Army of Me', n: 1 },
    { id: 'l:hyperballad', albumId: 'la:post', title: 'Hyperballad', n: 2 },
    { id: 'l:joga', albumId: 'la:homogenic', title: 'Jóga', n: 1 },
    { id: 'l:bachelorette', albumId: 'la:homogenic', title: 'Bachelorette', n: 2 },
    { id: 'l:hellsbells', albumId: 'la:backinblack', title: 'Hells Bells', n: 1 },
    { id: 'l:backinblack', albumId: 'la:backinblack', title: 'Back in Black', n: 2 },
    { id: 'l:come', albumId: 'la:abbeyroad', title: 'Come Together', n: 1 },
    { id: 'l:something', albumId: 'la:abbeyroad', title: 'Something', n: 2 },
    { id: 'l:herecomesthe', albumId: 'la:abbeyroad', title: 'Here Comes the Sun', n: 3 },
    { id: 'l:eleanor', albumId: 'la:revolver', title: 'Eleanor Rigby', n: 1 },
    { id: 'l:yellowsub', albumId: 'la:revolver', title: 'Yellow Submarine', n: 2 },
    { id: 'l:tonight', albumId: 'la:mellon', title: 'Tonight, Tonight', n: 1 },
    { id: 'l:1979', albumId: 'la:mellon', title: '1979', n: 2 },
    { id: 'l:bullet', albumId: 'la:mellon', title: 'Bullet with Butterfly Wings', n: 3 },
    { id: 'l:teen', albumId: 'la:nevermind', title: 'Smells Like Teen Spirit', n: 1 },
    { id: 'l:inbloom', albumId: 'la:nevermind', title: 'In Bloom', n: 2 },
    { id: 'l:onemore', albumId: 'la:discovery', title: 'One More Time', n: 1 },
    { id: 'l:aero', albumId: 'la:discovery', title: 'Aerodynamic', n: 2 },
    { id: 'l:baker', albumId: 'la:citytocity', title: 'Baker Street', n: 1 },
    { id: 'l:rightdown', albumId: 'la:citytocity', title: 'Right Down the Line', n: 2 },
    { id: 'l:reaper', albumId: 'la:agents', title: "(Don't Fear) The Reaper", n: 1 },
    { id: 'l:godzilla', albumId: 'la:agents', title: 'Godzilla', n: 2 },
    { id: 'l:nutshell', albumId: 'la:jar', title: 'Nutshell', n: 1 },
    { id: 'l:noexcuses', albumId: 'la:jar', title: 'No Excuses', n: 2 },
    { id: 'l:dancing', albumId: 'la:greatest1', title: 'Dancing Queen', n: 1 },
    { id: 'l:bohemian', albumId: 'la:greatest2', title: 'Bohemian Rhapsody', n: 1 },
    { id: 'l:battery', albumId: 'la:puppets', title: 'Battery', n: 1 },
    { id: 'l:getlucky', albumId: 'la:ram', title: 'Get Lucky', n: 1 },
  ],
  credits: [
    { albumId: 'la:jar', artistId: 'ar:toby', role: 'Producer' },
    { albumId: 'la:mellon', artistId: 'ar:flood', role: 'Producer' },
    { albumId: 'la:nevermind', artistId: 'ar:toby', role: 'Engineer' },
  ],
};

function seeded(): { db: Db; search: Search } {
  const db = openDb(':memory:');
  seed(db, LIBRARY);
  return { db, search: createSearch(db) };
}

function names(r: { albums: { title: string }[]; artists: { name: string }[]; tracks: { title: string }[] }): string {
  return [
    ...r.albums.map((a) => `album:${a.title}`),
    ...r.artists.map((a) => `artist:${a.name}`),
    ...r.tracks.map((t) => `track:${t.title}`),
  ].join(' | ');
}

// ---------------------------------------------------------------- folding / examples

describe('search folding', () => {
  it('finds Björk without the diacritic, and via the artist top result', () => {
    const { search } = seeded();
    const r = search.search('bjork');
    expect(r.artists[0]).toMatchObject({ id: 'ar:bjork', name: 'Björk' });
    expect(r.top).toMatchObject({ kind: 'artist', artist: { id: 'ar:bjork' } });
    expect(r.albums.map((a) => a.id)).toContain('la:debut');
  });

  it('finds AC/DC without the slash', () => {
    const { search } = seeded();
    const r = search.search('acdc');
    expect(r.artists[0]).toMatchObject({ id: 'ar:acdc', name: 'AC/DC' });
    expect(r.top).toMatchObject({ kind: 'artist', artist: { id: 'ar:acdc' } });
  });

  it('finds The Beatles with and without the article', () => {
    const { search } = seeded();
    for (const q of ['beatles', 'the beatles']) {
      const r = search.search(q);
      expect(r.artists[0], q).toMatchObject({ id: 'ar:beatles', name: 'The Beatles' });
      expect(r.top, q).toMatchObject({ kind: 'artist', artist: { id: 'ar:beatles' } });
    }
  });

  it('folds apostrophes: "(Don\'t Fear) The Reaper"', () => {
    const { search } = seeded();
    const r = search.search('dont fear the reaper');
    expect(r.tracks[0]).toMatchObject({ id: 'l:reaper' });
    expect(r.top).toMatchObject({ kind: 'track', track: { id: 'l:reaper' } });
  });

  it('folds diacritics in track titles: Jóga', () => {
    const { search } = seeded();
    expect(search.search('joga').tracks[0]).toMatchObject({ id: 'l:joga', title: 'Jóga' });
  });
});

describe('search ranking', () => {
  it('ranks exact album titles first', () => {
    const { search } = seeded();
    const r = search.search('abbey road');
    expect(r.albums[0]).toMatchObject({ id: 'la:abbeyroad' });
    expect(r.top).toMatchObject({ kind: 'album', album: { id: 'la:abbeyroad' } });
  });

  it('tolerates typos in artist and album words', () => {
    const { search } = seeded();
    const r = search.search('smashng pumpkns');
    const all = names(r);
    expect(all, all).toContain('artist:The Smashing Pumpkins');
    expect(all, all).toContain('album:Mellon Collie and the Infinite Sadness');
  });

  it('tolerates a truncated word', () => {
    const { search } = seeded();
    const r = search.search('nutshel');
    expect(r.tracks[0]).toMatchObject({ id: 'l:nutshell', title: 'Nutshell' });
    // the album is offered even though its own title/artist do not match
    expect(r.albums.map((a) => a.id)).toContain('la:jar');
  });

  it('finds an album from two artist words plus a typo', () => {
    const { search } = seeded();
    const r = search.search('daft pnk discovery');
    expect(r.albums[0]).toMatchObject({ id: 'la:discovery' });
    expect(r.top).toMatchObject({ kind: 'album', album: { id: 'la:discovery' } });
  });

  it('finds a track from artist + title words', () => {
    const { search } = seeded();
    const r = search.search('rafferty baker street');
    expect(r.tracks[0]).toMatchObject({ id: 'l:baker', title: 'Baker Street' });
    expect(r.albums.map((a) => a.id)).toContain('la:citytocity');
  });

  it('finds an artist with a diacritic in its name', () => {
    const { search } = seeded();
    const r = search.search('oyster cult');
    expect(r.artists[0]).toMatchObject({ id: 'ar:blue', name: 'Blue Öyster Cult' });
  });

  it('searches credits: a producer finds albums they worked on', () => {
    const { search } = seeded();
    const r = search.search('toby wright');
    expect(r.albums.map((a) => a.id)).toContain('la:jar');
    expect(r.top).toMatchObject({ kind: 'album' });
    // credit-only people do not masquerade as artists (matches old /api/search)
    expect(r.artists.map((a) => a.id)).not.toContain('ar:toby');
  });

  it('searches genres', () => {
    const { search } = seeded();
    const r = search.search('metal');
    expect(r.albums.map((a) => a.id)).toContain('la:puppets');
  });

  it('boosts by plays when the plays table exists', () => {
    const db = openDb(':memory:');
    seed(db, {
      ...LIBRARY,
      plays: [{ trackId: 'l:bohemian', albumId: 'la:greatest2', times: 60 }],
    });
    const search = createSearch(db);
    const r = search.search('greatest hits');
    expect(r.albums[0]).toMatchObject({ id: 'la:greatest2' });
  });

  it('does not boost without plays', () => {
    const { search } = seeded();
    const r = search.search('greatest hits');
    // equal relevance; tie-break is deterministic (ref id)
    expect(r.albums.map((a) => a.id)).toEqual(['la:greatest1', 'la:greatest2']);
  });

  it('filters by source', () => {
    const { search } = seeded();
    const spotify = search.search('daft punk', { source: 'spotify' });
    expect(spotify.albums.map((a) => a.id)).toEqual(['la:ram']);
    const local = search.search('daft punk', { source: 'local' });
    expect(local.albums.map((a) => a.id)).toContain('la:discovery');
    expect(local.albums.map((a) => a.id)).not.toContain('la:ram');
  });

  it('returns an empty response for a blank query', () => {
    const { search } = seeded();
    expect(search.search('   ')).toEqual({ albums: [], artists: [], tracks: [], top: null });
  });

  it('returns nothing for unrelated gibberish only when nothing is close', () => {
    const { search } = seeded();
    expect(search.search('zzzzqqqq').albums).toEqual([]);
  });
});

// ---------------------------------------------------------------- relevance table

const RELEVANCE: { q: string; kind: 'album' | 'artist' | 'track'; id: string; within: number }[] = [
  { q: 'bjork', kind: 'artist', id: 'ar:bjork', within: 0 },
  { q: 'acdc', kind: 'artist', id: 'ar:acdc', within: 0 },
  { q: 'beatles', kind: 'artist', id: 'ar:beatles', within: 0 },
  { q: 'abbey road', kind: 'album', id: 'la:abbeyroad', within: 0 },
  { q: 'smashng pumpkns', kind: 'album', id: 'la:mellon', within: 2 },
  { q: 'nutshel', kind: 'track', id: 'l:nutshell', within: 0 },
  { q: 'daft pnk discovery', kind: 'album', id: 'la:discovery', within: 0 },
  { q: 'rafferty baker street', kind: 'track', id: 'l:baker', within: 0 },
  { q: 'oyster cult', kind: 'artist', id: 'ar:blue', within: 2 },
  { q: 'toby wright', kind: 'album', id: 'la:jar', within: 2 },
  { q: 'smells like teen spirit', kind: 'track', id: 'l:teen', within: 0 },
  { q: 'nevermind', kind: 'album', id: 'la:nevermind', within: 0 },
  { q: 'one more time', kind: 'track', id: 'l:onemore', within: 0 },
  { q: 'homogenic', kind: 'album', id: 'la:homogenic', within: 0 },
  { q: 'back in black', kind: 'album', id: 'la:backinblack', within: 0 },
  { q: 'revolver', kind: 'album', id: 'la:revolver', within: 0 },
  { q: 'metal', kind: 'album', id: 'la:puppets', within: 2 },
  { q: 'dont fear the reaper', kind: 'track', id: 'l:reaper', within: 0 },
  { q: 'joga', kind: 'track', id: 'l:joga', within: 0 },
  { q: 'venus as a boy', kind: 'track', id: 'l:venus', within: 0 },
  { q: 'city to city', kind: 'album', id: 'la:citytocity', within: 0 },
  { q: 'bullet with butterfly wings', kind: 'track', id: 'l:bullet', within: 0 },
  { q: 'queen', kind: 'artist', id: 'ar:queen', within: 1 },
];

describe('20-query relevance table', () => {
  it.each(RELEVANCE)('$q → $kind $id', ({ q, kind, id, within }) => {
    const { search } = seeded();
    const r = search.search(q);
    const list = kind === 'album' ? r.albums : kind === 'artist' ? r.artists : r.tracks;
    const index = list.findIndex((x) => x.id === id);
    expect(index, `${q} → ${names(r)}`).toBeGreaterThanOrEqual(0);
    expect(index, `${q} → ${names(r)}`).toBeLessThanOrEqual(within);
  });
});

// ---------------------------------------------------------------- maintenance

describe('index maintenance', () => {
  it('reindexes a new album incrementally', () => {
    const { db, search } = seeded();
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar:new', 'New Band');
    db.prepare(
      `INSERT INTO albums (id, source, title, artist_id, genres, added_at)
       VALUES ('la:new', 'local', 'Freshly Added', 'ar:new', '[]', ?)`,
    ).run(Date.now());
    expect(search.search('freshly added').albums).toEqual([]);

    const result = search.reindex(['la:new']);
    expect(result.indexed).toBeGreaterThan(0);
    expect(search.search('freshly added').albums[0]).toMatchObject({ id: 'la:new' });
    expect(search.search('new band').artists[0]).toMatchObject({ id: 'ar:new' });
  });

  it('picks up a renamed album on reindex(id)', () => {
    const { db, search } = seeded();
    db.prepare("UPDATE albums SET title = 'Brand New Record' WHERE id = 'la:debut'").run();
    search.reindex(['la:debut']);
    expect(search.search('brand new record').albums[0]).toMatchObject({ id: 'la:debut' });
    expect(search.search('debut').albums.map((a) => a.id)).not.toContain('la:debut');
  });

  it('drops an album that left the library', () => {
    const { db, search } = seeded();
    expect(search.search('homogenic').albums[0]).toMatchObject({ id: 'la:homogenic' });
    db.prepare('UPDATE albums SET in_library = 0 WHERE id = ?').run('la:homogenic');
    search.reindex(['la:homogenic']);
    expect(search.search('homogenic').albums).toEqual([]);
    // the artist still owns other albums, so Björk stays searchable
    expect(search.search('bjork').artists[0]).toMatchObject({ id: 'ar:bjork' });
  });

  it('a no-argument reindex sweeps changed rows without rewriting unchanged ones', () => {
    const { db, search } = seeded();
    const first = search.reindex();
    expect(first.indexed).toBe(0); // nothing changed since createSearch
    db.prepare("UPDATE tracks SET title = 'Teen Spirit (Remaster)' WHERE id = 'l:teen'").run();
    const second = search.reindex();
    expect(second.indexed).toBe(1);
    expect(search.search('teen spirit remaster').tracks[0]).toMatchObject({ id: 'l:teen' });
  });

  it('drops track docs when their album row is deleted', () => {
    const { db, search } = seeded();
    expect(search.search('nutshell').tracks[0]).toMatchObject({ id: 'l:nutshell' });
    db.prepare("DELETE FROM albums WHERE id = 'la:jar'").run();
    search.reindex(['la:jar']);
    expect(search.search('nutshell').tracks).toEqual([]);
    expect(search.search('nutshell').albums).toEqual([]);
  });

  it('rebuildAll recreates everything', () => {
    const { db, search } = seeded();
    const r = search.rebuildAll();
    expect(r.indexed).toBeGreaterThan(30);
    expect(search.search('abbey road').albums[0]).toMatchObject({ id: 'la:abbeyroad' });
    const count = (db.prepare('SELECT count(*) AS n FROM search_docs').get() as { n: number }).n;
    expect(count).toBe(r.indexed);
  });

  it('reindexes credits when the album is passed', () => {
    const { db, search } = seeded();
    db.prepare("INSERT INTO artists (id, name) VALUES ('ar:rick', 'Rick Rubin')").run();
    db.prepare("INSERT INTO credits (album_id, artist_id, role) VALUES ('la:post', 'ar:rick', 'Producer')").run();
    expect(search.search('rick rubin').albums).toEqual([]);
    search.reindex(['la:post']);
    expect(search.search('rick rubin').albums.map((a) => a.id)).toContain('la:post');
  });

  it('rebuilds at startup when the index table is empty', () => {
    const db = openDb(':memory:');
    seed(db, LIBRARY);
    createSearch(db); // first call fills
    db.exec('DELETE FROM search_docs');
    const second = createSearch(db); // empty table → rebuild
    expect(second.search('abbey road').albums[0]).toMatchObject({ id: 'la:abbeyroad' });
  });

  it('adds the ref_id index when migrating an existing database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'liner-search-migration-'));
    const path = join(dir, 'liner.db');
    const plan = (db: Db) =>
      (
        db
          .prepare('EXPLAIN QUERY PLAN SELECT title FROM search_docs WHERE ref_id = ?')
          .all('la:abbeyroad') as { detail: string }[]
      )
        .map((r) => r.detail)
        .join('\n');
    try {
      // Simulate an older DB: search tables exist, but the new index does not.
      let db = openDb(path);
      ensureSearchSchema(db);
      db.exec('DROP INDEX search_docs_ref');
      expect(plan(db)).not.toContain('search_docs_ref');
      db.close();

      // Reopening applies the migration to the existing database.
      db = openDb(path);
      ensureSearchSchema(db);
      expect(plan(db)).toContain('search_docs_ref'); // SEARCH ... USING INDEX search_docs_ref
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- route

describe('GET /search2', () => {
  it('returns the /api/search shape plus top', async () => {
    const { search } = seeded();
    const app = Fastify();
    registerSearchRoutes(app, search);
    const res = await app.inject({ method: 'GET', url: '/search2?q=bjork' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      albums: { id: string }[];
      artists: { id: string }[];
      tracks: { id: string }[];
      top: { kind: string; artist?: { id: string } };
    };
    expect(body.artists[0]).toMatchObject({ id: 'ar:bjork' });
    expect(body.top).toMatchObject({ kind: 'artist', artist: { id: 'ar:bjork' } });
    expect(Array.isArray(body.albums)).toBe(true);
    expect(Array.isArray(body.tracks)).toBe(true);
    await app.close();
  });

  it('is empty for a blank query', async () => {
    const { search } = seeded();
    const app = Fastify();
    registerSearchRoutes(app, search);
    const res = await app.inject({ method: 'GET', url: '/search2?q=' });
    expect(res.json()).toEqual({ albums: [], artists: [], tracks: [], top: null });
    await app.close();
  });
});
