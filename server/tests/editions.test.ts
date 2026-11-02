import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { openDb, ids, type Db } from '../src/db/index.js';
import type { Config } from '../src/config.js';
import { MbClient } from '../src/match/mb.js';
import {
  createEditions,
  editionsArtistMbid,
  editionFormat,
  editionLabel,
  ensureEditionsSchema,
  isDiscographyGroup,
  mbArtistOfficialReleasesUrl,
  mbReleaseGroupLookupUrl,
  mbReleaseGroupReleasesUrl,
  mbReleaseLookupUrl,
  normalizeEditionFormat,
  registerEditionsRoutes,
  releaseGroupType,
  type AlbumEditions,
  type ArtistDiscography,
  type EditionsService,
} from '../src/editions/index.js';

// ------------------------------------------------------------------ fixtures

interface Fixture {
  url: string;
  status: number;
  body: string;
  note?: string;
}

const fixtureDir = new URL('./fixtures/editions/', import.meta.url);
const allFixtures = readdirSync(fixtureDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8')) as Fixture);

const cfg: Config = {
  libraryRoots: [],
  dataDir: '/tmp/liner-editions-test',
  port: 0,
  audioDevice: 'null',
  userAgent: 'Liner/0.1 ( test )',
};

/** All response bodies for a slug's fixture kind (page 1, 2, ...), in order. */
function fixtureBodies(slug: string, kindPrefix: string): unknown[] {
  return readdirSync(fixtureDir)
    .filter((f) => f.startsWith(`${slug}--${kindPrefix}`) && f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(JSON.parse(readFileSync(new URL(f, fixtureDir), 'utf8')).body as string) as unknown);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

interface Harness {
  db: Db;
  editions: EditionsService;
  calls: string[];
  missing: string[];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function makeHarness(opts: { now?: () => number; ttlMs?: number; extra?: Fixture[] } = {}): Harness {
  const db = openDb(':memory:');
  cleanups.push(() => db.close());
  const routes = new Map<string, Fixture>(allFixtures.map((f) => [f.url, f]));
  for (const fixture of opts.extra ?? []) routes.set(fixture.url, fixture);

  const calls: string[] = [];
  const missing: string[] = [];
  const now = opts.now ?? (() => Date.now());
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    calls.push(url);
    const fixture = routes.get(url);
    if (!fixture) {
      missing.push(url);
      return new Response('fixture not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(fixture.body, {
      status: fixture.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const mb = new MbClient({ userAgent: cfg.userAgent, db, fetch: fakeFetch, rateLimitMs: 0, sleep: async () => {}, now });
  const editions = createEditions(db, cfg, {
    fetch: fakeFetch,
    mbClient: mb,
    now,
    ...(opts.ttlMs == null ? {} : { ttlMs: opts.ttlMs }),
  });
  return { db, editions, calls, missing };
}

interface SeedOptions {
  slug: string;
  title: string;
  artist: string;
  artistMbid?: string;
  year?: number;
  releaseDate?: string;
  releaseId?: string;
  releaseGroupId?: string;
  coverPath?: string;
  addedAt?: number;
  locked?: boolean;
}

function seedAlbum(db: Db, opts: SeedOptions): { albumId: string; artistId: string } {
  const artistId = opts.artistMbid ? ids.artistByMbid(opts.artistMbid) : ids.artistByName(opts.artist);
  db.prepare('INSERT OR REPLACE INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(
    artistId,
    opts.artist,
    opts.artistMbid ?? null,
  );
  const albumId = ids.localAlbum(`/music/${opts.slug}`);
  db.prepare(
    `INSERT OR REPLACE INTO albums
       (id, source, title, artist_id, year, release_date, cover_path, mb_release_id,
        mb_release_group_id, match_locked, added_at)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    albumId,
    opts.title,
    artistId,
    opts.year ?? null,
    opts.releaseDate ?? null,
    opts.coverPath ?? null,
    opts.releaseId ?? null,
    opts.releaseGroupId ?? null,
    opts.locked ? 1 : 0,
    opts.addedAt ?? Date.now(),
  );
  return { albumId, artistId };
}

function seedArtist(db: Db, opts: { id: string; name: string; mbid?: string }): void {
  db.prepare('INSERT OR REPLACE INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(
    opts.id,
    opts.name,
    opts.mbid ?? null,
  );
}

// ------------------------------------------------------------------ fixture data

const MBID = {
  radiohead: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  nirvana: '5b11f4ce-a62d-471e-81fc-a69a8278c7da',
  daft: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
  pumpkins: 'ba0d6274-db14-4ef5-b28d-657ebde1a396',
};

const OK_COMPUTER = {
  releaseId: '6a09041b-0f79-3278-88d9-0552dd28d37f',
  groupId: 'b1392450-e666-3926-a536-22c65f834433',
};

const NEVERMIND = {
  releaseId: '43d27d70-3e4f-46f0-b40e-ef4467145b0c',
  groupId: '1b022e01-4da6-387b-8658-8678046e4cef',
};

const DISCOVERY = {
  releaseId: 'c80cdcf0-0b8d-4c40-bbbb-54b286fd9a21',
  groupId: '48117b90-a16e-34ca-a514-19c702df1158',
};

// ------------------------------------------------------------------ album editions

describe('album editions (recorded MusicBrainz fixtures, offline)', () => {
  it('lists every edition of a release group (stored group id)', async () => {
    const h = makeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'ok-computer',
      title: 'OK Computer',
      artist: 'Radiohead',
      artistMbid: MBID.radiohead,
      year: 1997,
      releaseId: OK_COMPUTER.releaseId,
      releaseGroupId: OK_COMPUTER.groupId,
    });

    const result = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(result).not.toBeNull();
    expect(h.missing).toEqual([]);

    expect(result.originalReleaseDate).toBe('1997-05-21');
    expect(result.releaseGroupType).toBe('Album');
    expect(result.secondaryTypes).toEqual([]);

    // Fixture has 39 releases; every one is an edition.
    expect(result.editions).toHaveLength(39);
    expect(result.otherVersionsInLibrary).toEqual([]);

    const current = result.editions.filter((e) => e.isThisOne);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      mbReleaseId: OK_COMPUTER.releaseId,
      title: 'OK Computer',
      date: '1997-07-01',
      country: 'US',
      label: 'Capitol Records',
      catalogNumber: 'CDP 7243 8 55229 2 5',
      format: 'CD',
      trackCount: 12,
    });

    // Formats are normalised for display; "12\" Vinyl" -> "Vinyl", "Digital Media" -> "Digital".
    const formats = new Set(result.editions.map((e) => e.format).filter(Boolean));
    expect(formats.has('CD')).toBe(true);
    expect(formats.has('Vinyl')).toBe(true);
    expect(formats.has('Digital')).toBe(true);
    expect([...formats].some((f) => f?.includes('12"'))).toBe(false);

    // Chronological: known dates ascending, undated editions last.
    const dated = result.editions.filter((e) => e.date).map((e) => e.date as string);
    expect([...dated].sort()).toEqual(dated);
    const firstUndated = result.editions.findIndex((e) => !e.date);
    if (firstUndated >= 0) {
      expect(result.editions.slice(firstUndated).every((e) => !e.date)).toBe(true);
    }
  });

  it('discovers the release group from the release id when it was not stored', async () => {
    const h = makeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'nevermind',
      title: 'Nevermind',
      artist: 'Nirvana',
      artistMbid: MBID.nirvana,
      year: 1991,
      releaseId: NEVERMIND.releaseId,
    });

    const result = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(h.missing).toEqual([]);
    expect(h.calls[0]).toBe(mbReleaseLookupUrl(NEVERMIND.releaseId));
    expect(h.calls).toContain(mbReleaseGroupLookupUrl(NEVERMIND.groupId));
    expect(h.calls).toContain(mbReleaseGroupReleasesUrl(NEVERMIND.groupId));

    expect(result.originalReleaseDate).toBe('1991-09-24');
    expect(result.releaseGroupType).toBe('Album');
    expect(result.editions).toHaveLength(100);
    expect(result.editions.filter((e) => e.isThisOne).map((e) => e.mbReleaseId)).toEqual([NEVERMIND.releaseId]);
  });

  it('lists other library albums of the same release group', async () => {
    const h = makeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'nevermind',
      title: 'Nevermind',
      artist: 'Nirvana',
      artistMbid: MBID.nirvana,
      year: 1991,
      releaseId: NEVERMIND.releaseId,
      releaseGroupId: NEVERMIND.groupId,
      addedAt: 1000,
    });
    const other = seedAlbum(h.db, {
      slug: 'nevermind-deluxe',
      title: 'Nevermind (30th Anniversary Super Deluxe)',
      artist: 'Nirvana',
      artistMbid: MBID.nirvana,
      year: 2021,
      releaseGroupId: NEVERMIND.groupId,
      coverPath: '/covers/nevermind.jpg',
      addedAt: 2000,
    });

    const result = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(result.otherVersionsInLibrary).toHaveLength(1);
    expect(result.otherVersionsInLibrary[0]).toMatchObject({
      id: other.albumId,
      source: 'local',
      title: 'Nevermind (30th Anniversary Super Deluxe)',
      year: 2021,
      artist: { id: other.artistId, name: 'Nirvana' },
      coverUrl: `/api/cover/${encodeURIComponent(other.albumId)}?size=600`,
    });
  });

  it('serves a local-only minimal response for albums without MB ids', async () => {
    const h = makeHarness();
    const { albumId, artistId } = seedAlbum(h.db, {
      slug: 'local-only',
      title: 'Greatest Hits!',
      artist: 'Some Band',
      year: 2004,
      releaseDate: '2004-03-23',
      addedAt: 10,
    });
    const sibling = seedAlbum(h.db, {
      slug: 'local-only-alt',
      title: 'greatest hits',
      artist: 'Some Band',
      year: 2005,
      addedAt: 20,
    });

    const result = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(result).toEqual({
      originalReleaseDate: '2004-03-23',
      secondaryTypes: [],
      editions: [],
      otherVersionsInLibrary: [
        {
          id: sibling.albumId,
          source: 'local',
          title: 'greatest hits',
          artist: { id: artistId, name: 'Some Band' },
          year: 2005,
          addedAt: 20,
        },
      ],
    });
    expect(h.calls).toEqual([]);
  });

  it('returns null only for an unknown album id', async () => {
    const h = makeHarness();
    expect(await h.editions.getAlbumEditions('la:does-not-exist')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('caches MB results for 30 days and refetches when stale or refresh is requested', async () => {
    let clock = 1_000_000_000_000;
    const h = makeHarness({ now: () => clock });
    const { albumId } = seedAlbum(h.db, {
      slug: 'discovery',
      title: 'Discovery',
      artist: 'Daft Punk',
      artistMbid: MBID.daft,
      year: 2001,
      releaseId: DISCOVERY.releaseId,
      releaseGroupId: DISCOVERY.groupId,
    });

    const first = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(first.editions).toHaveLength(24);
    const callsAfterFirst = h.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Warm cache: no network at all.
    const second = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(second).toEqual(first);
    expect(h.calls.length).toBe(callsAfterFirst);

    const row = h.db
      .prepare("SELECT kind, mb_key, fetched_at FROM editions_cache WHERE kind = 'album-editions' AND ref_id = ?")
      .get(albumId) as { kind: string; mb_key: string; fetched_at: number };
    expect(row.mb_key).toBe(`${DISCOVERY.releaseId}|${DISCOVERY.groupId}`);
    expect(row.fetched_at).toBe(clock);

    // 31 days later both the editions cache and the shared http_cache are stale.
    clock += 31 * 24 * 60 * 60 * 1000;
    await h.editions.getAlbumEditions(albumId);
    expect(h.calls.length).toBeGreaterThan(callsAfterFirst);

    // Explicit refresh rebuilds the editions cache even while it is fresh. The
    // shared http_cache still serves the raw MB responses (also 30 days), so no
    // new network call is needed — but a new fetched_at is written.
    clock += 1000;
    const beforeRefresh = h.calls.length;
    await h.editions.getAlbumEditions(albumId, { refresh: true });
    expect(h.calls.length).toBe(beforeRefresh);
    const refreshed = h.db
      .prepare("SELECT fetched_at FROM editions_cache WHERE kind = 'album-editions' AND ref_id = ?")
      .get(albumId) as { fetched_at: number };
    expect(refreshed.fetched_at).toBe(clock);
  });

  it('deduplicates concurrent requests for the same album', async () => {
    const h = makeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'ok-computer-concurrent',
      title: 'OK Computer',
      artist: 'Radiohead',
      artistMbid: MBID.radiohead,
      releaseId: OK_COMPUTER.releaseId,
      releaseGroupId: OK_COMPUTER.groupId,
    });

    const [first, second] = await Promise.all([
      h.editions.getAlbumEditions(albumId),
      h.editions.getAlbumEditions(albumId),
    ]);
    expect(second).toEqual(first);
    // One release-group lookup + one releases page, not two of each.
    expect(h.calls).toEqual([
      mbReleaseGroupLookupUrl(OK_COMPUTER.groupId),
      mbReleaseGroupReleasesUrl(OK_COMPUTER.groupId),
    ]);
  });

  it('falls back to local data when MusicBrainz cannot be reached', async () => {
    const h = makeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'ghost-mb',
      title: 'Unreachable',
      artist: 'Unknown Band',
      year: 1999,
      releaseId: '11111111-2222-3333-4444-555555555555',
      releaseGroupId: '66666666-7777-8888-9999-000000000000',
    });

    const result = (await h.editions.getAlbumEditions(albumId)) as AlbumEditions;
    expect(h.missing.length).toBeGreaterThan(0);
    expect(result).toEqual({
      originalReleaseDate: '1999',
      secondaryTypes: [],
      editions: [],
      otherVersionsInLibrary: [],
    });
    // Failures are not cached: the response was not written.
    expect(
      h.db.prepare("SELECT count(*) AS n FROM editions_cache WHERE ref_id = ?").get(albumId) as { n: number },
    ).toEqual({ n: 0 });
  });
});

// ------------------------------------------------------------------ discography

interface RawGroup {
  id: string;
  title?: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
}

/** Release groups present across a slug's recorded official-release pages. */
function discographyFixtureGroups(slug: string): RawGroup[] {
  const seen = new Map<string, RawGroup>();
  for (const body of fixtureBodies(slug, 'discography-releases-p')) {
    const releases = (body as { releases?: { 'release-group'?: RawGroup }[] }).releases ?? [];
    for (const release of releases) {
      const group = release['release-group'];
      if (group?.id && !seen.has(group.id)) seen.set(group.id, group);
    }
  }
  return [...seen.values()];
}

describe('artist discography (recorded MusicBrainz fixtures, offline)', () => {
  const CASES = [
    {
      slug: 'smashing-pumpkins',
      name: 'The Smashing Pumpkins',
      mbid: MBID.pumpkins,
      ownedTitle: 'Gish',
      ownedGroupId: '4ac82f0b-1532-3734-80d7-5c02265197aa',
      missingTitle: 'Siamese Dream',
      missingGroupId: 'a159e102-18bb-42ca-a59e-5f96a7eff241',
      excludedSingle: 'Disarm',
    },
    {
      slug: 'daft-punk',
      name: 'Daft Punk',
      mbid: MBID.daft,
      ownedTitle: 'Discovery',
      ownedGroupId: DISCOVERY.groupId,
      missingTitle: 'Homework',
      missingGroupId: '00054665-89fa-33d5-a8f0-1728ea8c32c3',
      excludedSingle: 'Aerodynamic',
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name}: albums/EPs/live/compilations, owned and missing`, async () => {
      const h = makeHarness();
      seedArtist(h.db, { id: ids.artistByMbid(testCase.mbid), name: testCase.name, mbid: testCase.mbid });
      const { albumId } = seedAlbum(h.db, {
        slug: `${testCase.slug}-owned`,
        title: testCase.ownedTitle,
        artist: testCase.name,
        artistMbid: testCase.mbid,
        releaseGroupId: testCase.ownedGroupId,
      });

      const result = (await h.editions.getArtistDiscography(ids.artistByMbid(testCase.mbid))) as ArtistDiscography;
      expect(h.missing).toEqual([]);
      expect(result.releaseGroups.length).toBeGreaterThan(5);

      const byId = new Map(result.releaseGroups.map((g) => [g.mbReleaseGroupId, g]));
      expect(byId.get(testCase.ownedGroupId)).toMatchObject({
        title: testCase.ownedTitle,
        owned: true,
        albumIds: [albumId],
      });
      expect(byId.get(testCase.missingGroupId)).toMatchObject({
        title: testCase.missingTitle,
        owned: false,
        albumIds: [],
      });

      // Singles and broadcasts are not part of a discography.
      expect(result.releaseGroups.some((g) => g.title === testCase.excludedSingle)).toBe(false);
      expect(result.releaseGroups.every((g) => g.type !== 'Single' && g.type !== 'Broadcast')).toBe(true);
      expect(result.releaseGroups.filter((g) => !g.owned).length).toBeGreaterThan(0);

      // Live/compilation groups carry their secondary type, and the display type
      // prefers it over the generic primary "Album".
      const live = result.releaseGroups.find((g) => g.secondaryTypes.includes('Live'));
      if (live) expect(live.type).toBe('Live');
      const compilation = result.releaseGroups.find((g) => g.secondaryTypes.includes('Compilation'));
      if (compilation) expect(compilation.type).toBe('Compilation');

      // Chronological (unknown years last).
      const years = result.releaseGroups.map((g) => g.year ?? 9999);
      expect([...years].sort((a, b) => a - b)).toEqual(years);

      // Fixture covers the whole filtered list.
      const expected = discographyFixtureGroups(testCase.slug).filter((g) =>
        isDiscographyGroup({ 'primary-type': g['primary-type'], 'secondary-types': g['secondary-types'] }),
      );
      expect(result.releaseGroups).toHaveLength(expected.length);
    });
  }

  it('caches the MB list but recomputes owned flags from the library', async () => {
    const h = makeHarness();
    const artistId = ids.artistByMbid(MBID.pumpkins);
    seedArtist(h.db, { id: artistId, name: 'The Smashing Pumpkins', mbid: MBID.pumpkins });

    const first = (await h.editions.getArtistDiscography(artistId)) as ArtistDiscography;
    expect(first.releaseGroups.every((g) => !g.owned)).toBe(true);
    const callsAfterFirst = h.calls.length;

    // Match an album afterwards: the 30-day cache must still show it as owned.
    const { albumId } = seedAlbum(h.db, {
      slug: 'gish-later',
      title: 'Gish',
      artist: 'The Smashing Pumpkins',
      artistMbid: MBID.pumpkins,
      releaseGroupId: '4ac82f0b-1532-3734-80d7-5c02265197aa',
    });

    const second = (await h.editions.getArtistDiscography(artistId)) as ArtistDiscography;
    expect(h.calls.length).toBe(callsAfterFirst);
    expect(second.releaseGroups.find((g) => g.mbReleaseGroupId === '4ac82f0b-1532-3734-80d7-5c02265197aa')).toMatchObject({
      owned: true,
      albumIds: [albumId],
    });
  });

  it('returns an empty list for an artist without a MusicBrainz id', async () => {
    const h = makeHarness();
    seedArtist(h.db, { id: ids.artistByName('Local Only'), name: 'Local Only' });
    expect(await h.editions.getArtistDiscography(ids.artistByName('Local Only'))).toEqual({ releaseGroups: [] });
    expect(h.calls).toEqual([]);
  });

  it('returns null only for an unknown artist id', async () => {
    const h = makeHarness();
    expect(await h.editions.getArtistDiscography('ar:does-not-exist')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('uses the uuid embedded in an ar:<uuid> id when artists.mbid is empty', async () => {
    const h = makeHarness();
    const artistId = ids.artistByMbid(MBID.daft);
    seedArtist(h.db, { id: artistId, name: 'Daft Punk' });
    const result = (await h.editions.getArtistDiscography(artistId)) as ArtistDiscography;
    expect(result.releaseGroups.length).toBeGreaterThan(0);
    expect(h.missing).toEqual([]);
  });
});

// ------------------------------------------------------------------ routes

describe('editions routes', () => {
  async function routeHarness(): Promise<{ h: Harness; app: ReturnType<typeof Fastify> }> {
    const h = makeHarness();
    const app = Fastify();
    registerEditionsRoutes(app, h.editions);
    cleanups.push(() => void app.close());
    return { h, app };
  }

  it('GET /albums/:id/editions', async () => {
    const { h, app } = await routeHarness();
    const { albumId } = seedAlbum(h.db, {
      slug: 'ok-computer-route',
      title: 'OK Computer',
      artist: 'Radiohead',
      artistMbid: MBID.radiohead,
      releaseId: OK_COMPUTER.releaseId,
      releaseGroupId: OK_COMPUTER.groupId,
    });

    const res = await app.inject({ method: 'GET', url: `/albums/${encodeURIComponent(albumId)}/editions` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AlbumEditions;
    expect(Object.keys(body).sort()).toEqual(
      ['editions', 'originalReleaseDate', 'otherVersionsInLibrary', 'releaseGroupType', 'secondaryTypes'].sort(),
    );
    expect(body.releaseGroupType).toBe('Album');
    expect(body.editions.filter((e) => e.isThisOne)).toHaveLength(1);

    const missing = await app.inject({ method: 'GET', url: '/albums/la%3Anope/editions' });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /artists/:id/discography', async () => {
    const { h, app } = await routeHarness();
    const artistId = ids.artistByMbid(MBID.daft);
    seedArtist(h.db, { id: artistId, name: 'Daft Punk', mbid: MBID.daft });

    const res = await app.inject({ method: 'GET', url: `/artists/${encodeURIComponent(artistId)}/discography` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ArtistDiscography;
    expect(body.releaseGroups.length).toBeGreaterThan(0);
    expect(body.releaseGroups.every((g) => Array.isArray(g.albumIds) && typeof g.owned === 'boolean')).toBe(true);

    const missing = await app.inject({ method: 'GET', url: '/artists/ar%3Anope/discography' });
    expect(missing.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------ helpers

describe('helpers', () => {
  it('applies the migration idempotently', () => {
    const db = openDb(':memory:');
    cleanups.push(() => db.close());
    ensureEditionsSchema(db);
    ensureEditionsSchema(db);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'editions_cache'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe('editions_cache');
  });

  it('normalises media formats', () => {
    expect(normalizeEditionFormat('CD')).toBe('CD');
    expect(normalizeEditionFormat('12" Vinyl')).toBe('Vinyl');
    expect(normalizeEditionFormat('Digital Media')).toBe('Digital');
    expect(normalizeEditionFormat('CD-R')).toBe('CD-R');
    expect(normalizeEditionFormat('Cassette')).toBe('Cassette');
    expect(normalizeEditionFormat(null)).toBeUndefined();
    expect(editionFormat({ media: [{ format: 'CD' }, { format: 'DVD-Video' }] })).toBe('CD, DVD-Video');
    expect(editionFormat({ media: [{ format: 'CD' }, { format: 'CD' }] })).toBe('CD');
    expect(editionFormat({ media: [] })).toBeUndefined();
  });

  it('joins label and catalog number info', () => {
    expect(
      editionLabel({
        'label-info': [
          { 'catalog-number': 'A1', label: { name: 'Parlophone' } },
          { 'catalog-number': 'B2', label: { name: 'Capitol Records' } },
        ],
      }),
    ).toEqual({ label: 'Parlophone / Capitol Records', catalogNumber: 'A1 / B2' });
    expect(editionLabel({})).toEqual({});
  });

  it('picks a useful display type and filters discography groups', () => {
    expect(releaseGroupType({ 'primary-type': 'Album', 'secondary-types': [] })).toBe('Album');
    expect(releaseGroupType({ 'primary-type': 'EP', 'secondary-types': [] })).toBe('EP');
    expect(releaseGroupType({ 'primary-type': 'Album', 'secondary-types': ['Live'] })).toBe('Live');
    expect(releaseGroupType({ 'primary-type': 'Album', 'secondary-types': ['Compilation'] })).toBe('Compilation');
    expect(releaseGroupType({ 'primary-type': null, 'secondary-types': ['Soundtrack'] })).toBe('Soundtrack');

    expect(isDiscographyGroup({ 'primary-type': 'Album', 'secondary-types': [] })).toBe(true);
    expect(isDiscographyGroup({ 'primary-type': 'EP', 'secondary-types': [] })).toBe(true);
    expect(isDiscographyGroup({ 'primary-type': 'Album', 'secondary-types': ['Live'] })).toBe(true);
    expect(isDiscographyGroup({ 'primary-type': 'Album', 'secondary-types': ['Compilation', 'Live'] })).toBe(true);
    expect(isDiscographyGroup({ 'primary-type': 'Single', 'secondary-types': ['Remix'] })).toBe(false);
    expect(isDiscographyGroup({ 'primary-type': 'Broadcast', 'secondary-types': ['DJ-mix'] })).toBe(false);
    expect(isDiscographyGroup({ 'primary-type': 'Album', 'secondary-types': ['Interview'] })).toBe(false);
    expect(isDiscographyGroup({ 'primary-type': null, 'secondary-types': ['Live', 'DJ-mix'] })).toBe(true);
  });

  it('finds the artist mbid from the column or an ar:<uuid> id', () => {
    expect(editionsArtistMbid(`ar:${MBID.daft}`, null)).toBe(MBID.daft);
    expect(editionsArtistMbid('ar:n:1234', MBID.daft)).toBe(MBID.daft);
    expect(editionsArtistMbid('ar:n:1234', null)).toBeUndefined();
    expect(editionsArtistMbid('ar:not-a-uuid', null)).toBeUndefined();
  });

  it('builds deterministic MusicBrainz URLs', () => {
    expect(mbReleaseLookupUrl('abc')).toBe(
      'https://musicbrainz.org/ws/2/release/abc?inc=release-groups&fmt=json',
    );
    expect(mbReleaseGroupLookupUrl('abc')).toBe('https://musicbrainz.org/ws/2/release-group/abc?fmt=json');
    const releases = new URL(mbReleaseGroupReleasesUrl('rg-1', 100));
    expect(releases.pathname).toBe('/ws/2/release/');
    expect(releases.searchParams.get('release-group')).toBe('rg-1');
    expect(releases.searchParams.get('inc')).toBe('labels+media');
    expect(releases.searchParams.get('offset')).toBe('100');
    const artist = new URL(mbArtistOfficialReleasesUrl('mb-1', 200));
    expect(artist.pathname).toBe('/ws/2/release/');
    expect(artist.searchParams.get('artist')).toBe('mb-1');
    expect(artist.searchParams.get('status')).toBe('official');
    expect(artist.searchParams.get('offset')).toBe('200');
  });
});
