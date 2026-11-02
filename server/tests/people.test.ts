import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../src/db/index.js';
import {
  registerPeopleRoutes,
  type AlbumConnections,
  type PeopleOptions,
  type PersonPage,
  type PersonSummary,
} from '../src/people/index.js';

const THOM_MBID = '8ed2e0b3-aa4c-4e13-bec3-dc7393ed4d6b';
const RADIOHEAD_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const NIGEL_MBID = '52de022d-5401-427f-8301-ff1b8be11a7a';

const fixtureDir = new URL('./fixtures/people/', import.meta.url);
const thomJson = readFileSync(new URL('artist-thom.json', fixtureDir), 'utf8');
const radioheadJson = readFileSync(new URL('artist-radiohead.json', fixtureDir), 'utf8');

// ---------- seed ----------

function seed(db: Db): void {
  const artist = db.prepare('INSERT INTO artists (id, name, mbid) VALUES (?, ?, ?)');
  for (const [id, name, mbid] of [
    ['ar:band', 'Radiohead', RADIOHEAD_MBID],
    ['ar:thom', 'Thom Yorke', THOM_MBID],
    ['ar:nigel', 'Nigel Godrich', NIGEL_MBID],
    ['ar:jonny', 'Jonny Greenwood', null],
    ['ar:guest', 'Guest Musician', null],
    ['ar:colin', 'Colin Greenwood', null],
  ] as const) {
    artist.run(id, name, mbid);
  }

  const album = db.prepare(
    `INSERT INTO albums (id, source, title, artist_id, year, format, cover_path, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?)`,
  );
  const albums = [
    ['la:okc', 'OK Computer', 'ar:band', 1997, 'FLAC 16/44.1', '/covers/okc.jpg', 100],
    ['la:kida', 'Kid A', 'ar:band', 2000, 'FLAC 16/44.1', '/covers/kida.jpg', 200],
    ['la:amnesiac', 'Amnesiac', 'ar:band', 2001, null, null, 300],
    ['la:httf', 'Hail to the Thief', 'ar:band', 2003, null, null, 400],
    ['la:eraser', 'The Eraser', 'ar:thom', 2006, null, null, 500],
    ['la:nigel', 'Nigel Presents', 'ar:nigel', 2010, null, null, 600],
  ] as const;
  for (const a of albums) album.run(...a);

  const track = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path)
     VALUES (?, ?, 'local', ?, 1, ?, 1000, ?)`,
  );
  track.run('l:k1', 'la:kida', 'Everything in Its Right Place', 1, '/music/secret/k1.flac');
  track.run('l:k2', 'la:kida', 'Kid A', 2, '/music/secret/k2.flac');

  const credit = db.prepare(
    'INSERT INTO credits (album_id, artist_id, role, track_ids) VALUES (?, ?, ?, ?)',
  );
  const credits: [string, string, string, string | null][] = [
    ['la:kida', 'ar:nigel', 'Producer', null],
    ['la:kida', 'ar:nigel', 'Engineer', JSON.stringify(['l:k2'])],
    ['la:kida', 'ar:thom', 'Composer', JSON.stringify(['l:k2'])],
    ['la:kida', 'ar:thom', 'Guitar', JSON.stringify(['l:k1', 'l:k2'])],
    ['la:kida', 'ar:jonny', 'Ondes Martenot', JSON.stringify(['l:k1'])],
    ['la:amnesiac', 'ar:nigel', 'Producer', null],
    ['la:amnesiac', 'ar:thom', 'Composer', null],
    ['la:amnesiac', 'ar:thom', 'Background Vocals', null],
    ['la:amnesiac', 'ar:jonny', 'Guitar', null],
    ['la:amnesiac', 'ar:guest', 'Mix', null],
    ['la:okc', 'ar:nigel', 'Producer', null],
    ['la:okc', 'ar:guest', 'Mix', null],
    ['la:okc', 'ar:colin', 'Bass Guitar', null],
    ['la:httf', 'ar:nigel', 'Producer', null],
    ['la:httf', 'ar:guest', 'Guitar', null],
    ['la:eraser', 'ar:thom', 'Producer', null],
  ];
  for (const c of credits) credit.run(...c);
}

function seededDb(): Db {
  const db = openDb(':memory:');
  seed(db);
  return db;
}

// ---------- app harness ----------

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function makeApp(db: Db, opts: PeopleOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Offline by default: no test reaches MusicBrainz unless it injects a fetch.
  registerPeopleRoutes(app, db, { enabled: false, ...opts });
  await app.ready();
  apps.push(app);
  return app;
}

async function getJson<T>(app: FastifyInstance, url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode, `${url} → ${res.body}`).toBe(200);
  return res.json() as T;
}

// ---------- one person ----------

describe('GET /people/:artistId', () => {
  it('returns role counts, albums, grouped credits and collaborators', async () => {
    const app = await makeApp(seededDb());
    const page = await getJson<PersonPage>(app, '/people/ar:nigel');

    expect(page.id).toBe('ar:nigel');
    expect(page.name).toBe('Nigel Godrich');
    expect(page.roles).toEqual([
      { role: 'Producer', count: 4 },
      { role: 'Engineer', count: 1 },
    ]);
    expect(page.musicbrainz).toBeUndefined();

    // Album artist only (no credits on this one).
    expect(page.asArtist.map((a) => a.id)).toEqual(['la:nigel']);

    // Grouped by album, chronological; no duplicate album entries.
    expect(page.credits.map((c) => c.album.id)).toEqual(['la:okc', 'la:kida', 'la:amnesiac', 'la:httf']);

    const kidA = page.credits.find((c) => c.album.id === 'la:kida')!;
    expect(kidA.roles).toEqual(['Engineer', 'Producer']);
    expect(kidA.tracks).toEqual([{ id: 'l:k2', title: 'Kid A' }]);
    expect(kidA.album).toEqual({
      id: 'la:kida',
      source: 'local',
      title: 'Kid A',
      artist: { id: 'ar:band', name: 'Radiohead' },
      year: 2000,
      coverUrl: '/api/cover/la%3Akida?size=600',
      format: 'FLAC 16/44.1',
      addedAt: 200,
    });

    // Whole-album credits carry no track list.
    const okc = page.credits.find((c) => c.album.id === 'la:okc')!;
    expect(okc.roles).toEqual(['Producer']);
    expect(okc).not.toHaveProperty('tracks');

    expect(page.collaborators).toEqual([
      { artist: { id: 'ar:guest', name: 'Guest Musician' }, sharedAlbums: 3 },
      { artist: { id: 'ar:jonny', name: 'Jonny Greenwood' }, sharedAlbums: 2 },
      { artist: { id: 'ar:thom', name: 'Thom Yorke' }, sharedAlbums: 2 },
      { artist: { id: 'ar:colin', name: 'Colin Greenwood' }, sharedAlbums: 1 },
    ]);

    // Never leak local file paths.
    expect(JSON.stringify(page)).not.toContain('/music/secret');
  });

  it('lists credits chronologically and asArtist separately for a performer', async () => {
    const app = await makeApp(seededDb());
    const thom = await getJson<PersonPage>(app, '/people/ar:thom');

    expect(thom.asArtist.map((a) => a.id)).toEqual(['la:eraser']);
    expect(thom.roles).toEqual([
      { role: 'Composer', count: 2 },
      { role: 'Background Vocals', count: 1 },
      { role: 'Guitar', count: 1 },
      { role: 'Producer', count: 1 },
    ]);
    expect(thom.credits.map((c) => c.album.id)).toEqual(['la:kida', 'la:amnesiac', 'la:eraser']);
    expect(thom.credits[0]!.roles).toEqual(['Composer', 'Guitar']);
    expect(thom.credits[0]!.tracks).toEqual([
      { id: 'l:k1', title: 'Everything in Its Right Place' },
      { id: 'l:k2', title: 'Kid A' },
    ]);
    expect(thom.credits[1]!.roles).toEqual(['Background Vocals', 'Composer']);
    expect(thom.credits[1]!).not.toHaveProperty('tracks');
    expect(thom.collaborators).toEqual([
      { artist: { id: 'ar:jonny', name: 'Jonny Greenwood' }, sharedAlbums: 2 },
      { artist: { id: 'ar:nigel', name: 'Nigel Godrich' }, sharedAlbums: 2 },
      { artist: { id: 'ar:guest', name: 'Guest Musician' }, sharedAlbums: 1 },
    ]);
  });

  it('caps collaborators at 12', async () => {
    const db = openDb(':memory:');
    const artist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
    const album = db.prepare(
      `INSERT INTO albums (id, source, title, artist_id, year, added_at) VALUES (?,'local',?,?,?,?)`,
    );
    const credit = db.prepare('INSERT INTO credits (album_id, artist_id, role, track_ids) VALUES (?,?,?,NULL)');
    artist.run('ar:me', 'Main Person');
    album.run('la:shared', 'Shared Record', 'ar:me', 2000, 1);
    credit.run('la:shared', 'ar:me', 'Producer');
    for (let i = 1; i <= 13; i++) {
      const n = String(i).padStart(2, '0');
      artist.run(`ar:c${n}`, `Collaborator ${n}`);
      album.run(`la:c${n}`, `Record ${n}`, 'ar:me', 2000, i + 1);
      credit.run(`la:c${n}`, 'ar:me', 'Producer');
      credit.run(`la:c${n}`, `ar:c${n}`, 'Guitar');
    }

    const app = await makeApp(db);
    const page = await getJson<PersonPage>(app, '/people/ar:me');
    expect(page.collaborators).toHaveLength(12);
    expect(page.collaborators.map((c) => c.artist.name)).not.toContain('Collaborator 13');
    expect(page.collaborators.every((c) => c.sharedAlbums === 1)).toBe(true);
  });

  it('404s for an unknown artist', async () => {
    const app = await makeApp(seededDb());
    const res = await app.inject({ method: 'GET', url: '/people/ar:missing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('honours albums.in_library when the Spotify migration added it', async () => {
    const db = openDb(':memory:');
    db.exec('ALTER TABLE albums ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1');
    seed(db);
    db.exec("UPDATE albums SET in_library = 0 WHERE id = 'la:httf'");
    const app = await makeApp(db);

    const page = await getJson<PersonPage>(app, '/people/ar:nigel');
    expect(page.roles).toEqual([
      { role: 'Producer', count: 3 },
      { role: 'Engineer', count: 1 },
    ]);
    expect(page.credits.map((c) => c.album.id)).toEqual(['la:okc', 'la:kida', 'la:amnesiac']);
    expect(page.collaborators.find((c) => c.artist.id === 'ar:guest')!.sharedAlbums).toBe(2);
  });
});

// ---------- browse ----------

describe('GET /people', () => {
  it('lists credited people with distinct album counts and roles', async () => {
    const app = await makeApp(seededDb());
    const people = await getJson<PersonSummary[]>(app, '/people');

    expect(people.map((p) => [p.id, p.albumCount])).toEqual([
      ['ar:nigel', 4],
      ['ar:guest', 3],
      ['ar:thom', 3],
      ['ar:jonny', 2],
      ['ar:colin', 1],
    ]);
    expect(people[0]!.roles).toEqual(['Engineer', 'Producer']);
    // Album artists with no credits are not "people" yet.
    expect(people.map((p) => p.id)).not.toContain('ar:band');
  });

  it('filters by role (case-insensitive) and name substring', async () => {
    const app = await makeApp(seededDb());

    const producers = await getJson<PersonSummary[]>(app, '/people?role=producer');
    expect(producers.map((p) => p.id)).toEqual(['ar:nigel', 'ar:thom']);
    expect(producers[0]!.albumCount).toBe(4);

    const composers = await getJson<PersonSummary[]>(app, '/people?role=Composer');
    expect(composers.map((p) => p.id)).toEqual(['ar:thom']);

    const green = await getJson<PersonSummary[]>(app, '/people?q=green');
    expect(green.map((p) => p.id)).toEqual(['ar:jonny', 'ar:colin']);

    // LIKE metacharacters stay literal.
    expect(await getJson<PersonSummary[]>(app, '/people?q=%25')).toEqual([]);
    // Repeated keys do not crash (Fastify hands them over as an array).
    const repeated = await getJson<PersonSummary[]>(app, '/people?role=Producer&role=Composer');
    expect(repeated.map((p) => p.id)).toEqual(['ar:nigel', 'ar:thom']);
  });

  it('honours albums.in_library when present', async () => {
    const db = openDb(':memory:');
    db.exec('ALTER TABLE albums ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1');
    seed(db);
    db.exec("UPDATE albums SET in_library = 0 WHERE id = 'la:httf'");
    const app = await makeApp(db);

    const people = await getJson<PersonSummary[]>(app, '/people');
    expect(people.find((p) => p.id === 'ar:nigel')!.albumCount).toBe(3);
    expect(people.find((p) => p.id === 'ar:guest')!.albumCount).toBe(2);
  });
});

// ---------- album connections ----------

describe('GET /albums/:id/connections', () => {
  it('finds albums sharing credited people, with who links them', async () => {
    const app = await makeApp(seededDb());
    const body = await getJson<AlbumConnections>(app, '/albums/la:kida/connections');

    expect(body.albumId).toBe('la:kida');
    expect(body.connections.map((c) => c.album.id)).toEqual([
      'la:amnesiac',
      'la:okc',
      'la:httf',
      'la:eraser',
    ]);

    // Amnesiac shares all three people from Kid A; roles are on the other album.
    expect(body.connections[0]!.people).toEqual([
      { artist: { id: 'ar:jonny', name: 'Jonny Greenwood' }, roles: ['Guitar'] },
      { artist: { id: 'ar:nigel', name: 'Nigel Godrich' }, roles: ['Producer'] },
      { artist: { id: 'ar:thom', name: 'Thom Yorke' }, roles: ['Background Vocals', 'Composer'] },
    ]);
    expect(body.connections[0]!.album.title).toBe('Amnesiac');
    expect(body.connections[1]!.people).toEqual([
      { artist: { id: 'ar:nigel', name: 'Nigel Godrich' }, roles: ['Producer'] },
    ]);
    // The source album is never in its own list; no local paths leak.
    expect(body.connections.map((c) => c.album.id)).not.toContain('la:kida');
    expect(JSON.stringify(body)).not.toContain('/music/secret');
  });

  it('returns no connections for an album with no credits and 404s for unknown albums', async () => {
    const app = await makeApp(seededDb());
    const empty = await getJson<AlbumConnections>(app, '/albums/la:nigel/connections');
    expect(empty).toEqual({ albumId: 'la:nigel', connections: [] });

    const res = await app.inject({ method: 'GET', url: '/albums/la:missing/connections' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
  });

  it('honours albums.in_library when present', async () => {
    const db = openDb(':memory:');
    db.exec('ALTER TABLE albums ADD COLUMN in_library INTEGER NOT NULL DEFAULT 1');
    seed(db);
    db.exec("UPDATE albums SET in_library = 0 WHERE id = 'la:httf'");
    const app = await makeApp(db);

    const body = await getJson<AlbumConnections>(app, '/albums/la:kida/connections');
    expect(body.connections.map((c) => c.album.id)).toEqual(['la:amnesiac', 'la:okc', 'la:eraser']);
  });
});

// ---------- MusicBrainz relations ----------

function fakeMbFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const body = url.includes(THOM_MBID) ? thomJson : url.includes(RADIOHEAD_MBID) ? radioheadJson : undefined;
    if (!body) return new Response('fixture not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

describe('MusicBrainz artist relations (recorded fixtures, offline)', () => {
  async function mbApp(): Promise<{ db: Db; app: FastifyInstance; calls: string[] }> {
    const db = seededDb();
    const calls: string[] = [];
    const app = await makeApp(db, {
      enabled: true,
      fetch: fakeMbFetch(calls),
      sleep: async () => {},
      rateLimitMs: 0,
      now: () => 1_000_000,
      userAgent: 'Liner/0.1 ( test )',
    });
    return { db, app, calls };
  }

  it('shows the bands a person is a member of, and caches once', async () => {
    const { db, app, calls } = await mbApp();

    const page = await getJson<PersonPage>(app, '/people/ar:thom');
    expect(page.musicbrainz).toEqual({
      type: 'Person',
      isPerson: true,
      memberOf: [
        { id: 'ar:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Atoms for Peace', begin: 2009 },
        {
          id: `ar:${RADIOHEAD_MBID}`,
          name: 'Radiohead',
          roles: ['guitar', 'lead vocals'],
          begin: 1985,
          end: 2025,
        },
        {
          id: 'ar:bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
          name: 'The Eraser Band',
          roles: ['keyboard'],
          begin: 2004,
          end: 2013,
        },
      ],
      members: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/artist/${THOM_MBID}`);

    // Second page view is served from people_rels — no further MB request.
    const again = await getJson<PersonPage>(app, '/people/ar:thom');
    expect(again.musicbrainz).toEqual(page.musicbrainz);
    expect(calls).toHaveLength(1);

    expect(db.prepare('SELECT mbid, found FROM people_rels WHERE artist_id = ?').get('ar:thom')).toEqual({
      mbid: THOM_MBID,
      found: 1,
    });
  });

  it('shows members for a band (backward relations) and distinguishes isPerson', async () => {
    const { app } = await mbApp();
    const band = await getJson<PersonPage>(app, '/people/ar:band');

    expect(band.musicbrainz).toEqual({
      type: 'Group',
      isPerson: false,
      memberOf: [],
      members: [
        {
          id: 'ar:d1f8be4e-1e2c-4e1a-9b4a-000000000001',
          name: 'Colin Greenwood',
          roles: ['bass'],
          begin: 1985,
        },
        {
          id: `ar:${THOM_MBID}`,
          name: 'Thom Yorke',
          roles: ['guitar', 'lead vocals'],
          begin: 1985,
        },
      ],
    });
  });

  it('never fetches for artists without an MBID, and caches failures', async () => {
    const { db, app, calls } = await mbApp();

    const jonny = await getJson<PersonPage>(app, '/people/ar:jonny');
    expect(jonny.musicbrainz).toBeUndefined();
    expect(calls).toHaveLength(0);

    const nigel = await getJson<PersonPage>(app, '/people/ar:nigel');
    expect(nigel.musicbrainz).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(db.prepare('SELECT found FROM people_rels WHERE artist_id = ?').get('ar:nigel')).toEqual({ found: 0 });

    // Cached failure: no retry on the next page view inside the TTL.
    await getJson<PersonPage>(app, '/people/ar:nigel');
    expect(calls).toHaveLength(1);
  });
});
