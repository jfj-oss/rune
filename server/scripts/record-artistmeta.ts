// Records real artist-metadata responses for the offline unit tests. Network is
// allowed here only (tests replay the JSON).
//
// Run: pnpm -C server exec tsx scripts/record-artistmeta.ts
//
// Fixtures live in tests/fixtures/artistmeta/ as:
//   { url, status, contentType?, body }            text / JSON responses
//   { url, status, contentType?, bodyBase64 }      downloaded image bytes
// Files are de-duplicated by URL across artists. No lyrics URL is ever fetched.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ids, type Db } from '../src/db/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { MbClient } from '../src/match/mb.js';
import { createArtistMeta, type ArtistMeta } from '../src/meta/artist.js';

const OUT = new URL('../tests/fixtures/artistmeta/', import.meta.url);

interface Target {
  slug: string;
  name: string;
  /** Canonical MBID when the artist is matched; undefined exercises the fallback. */
  mbid?: string;
  expectBio: boolean;
  note: string;
}

const targets: Target[] = [
  {
    slug: 'alice-in-chains',
    name: 'Alice in Chains',
    mbid: '4bd95eea-b9f6-4d70-a36c-cfea77431553',
    expectBio: true,
    note: 'MB url-rels -> Wikidata -> enwiki',
  },
  {
    slug: 'daft-punk',
    name: 'Daft Punk',
    mbid: '056e4f3e-d505-4dad-8ec1-d04f521cbb56',
    expectBio: true,
    note: 'MB url-rels -> Wikidata -> enwiki',
  },
  {
    slug: 'bill-withers',
    name: 'Bill Withers',
    mbid: 'fd1a2d9d-9bb6-44de-83a3-41560658aba9',
    expectBio: true,
    note: 'MB url-rels -> Wikidata -> enwiki',
  },
  {
    slug: 'blue-oyster-cult',
    name: 'Blue Öyster Cult',
    mbid: 'c7423e0c-ab3e-4ab4-be10-cdff5a9d3062',
    expectBio: true,
    note: 'diacritics + MB url-rels',
  },
  {
    slug: 'bill-withers-fallback',
    name: 'Bill Withers',
    mbid: undefined,
    expectBio: true,
    note: 'no mbid -> Wikipedia titles/category validation',
  },
  {
    slug: 'obscure',
    name: 'Xzzyq Fnord Trio',
    mbid: undefined,
    expectBio: false,
    note: 'no such artist -> cached empty result',
  },
];

interface Fixture {
  url: string;
  status: number;
  contentType?: string;
  body?: string;
  bodyBase64?: string;
  note?: string;
}

interface ImageRecord {
  url: string;
  status: number;
  contentType?: string;
  bytes: Buffer;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function maxCacheRowid(db: Db): number {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM http_cache').get() as { n: number };
  return row.n;
}

function kindFor(url: string): string | null {
  if (url.startsWith('https://musicbrainz.org/ws/2/artist/')) return 'mb-artist';
  if (url.startsWith('https://www.wikidata.org/w/api.php')) {
    return /[?&]list=search\b/.test(url) ? 'wikidata-search' : 'wikidata-entity';
  }
  if (url.startsWith('https://en.wikipedia.org/w/api.php')) {
    if (/[?&]generator=search\b/.test(url)) return 'wikipedia-search';
    const titles = new URL(url).searchParams.get('titles') ?? '';
    return titles.includes('|') ? 'wikipedia-titles' : 'wikipedia-page';
  }
  if (url.startsWith('https://commons.wikimedia.org/w/api.php')) return 'commons-imageinfo';
  return null;
}

function writeFixture(dir: string, base: string, fixture: Fixture, usedUrls: Set<string>): void {
  // One fixture per URL: several response kinds (e.g. direct page + fallback
  // title batch) can share a base name, and images can repeat across artists.
  if (usedUrls.has(fixture.url)) return;
  let file = `${base}.json`;
  let n = 2;
  while (readdirSync(dir).includes(file)) file = `${base}-${n++}.json`;
  writeFileSync(join(dir, file), `${JSON.stringify(fixture, null, 1)}\n`);
  usedUrls.add(fixture.url);
  const size = fixture.body?.length ?? (fixture.bodyBase64 ? Math.round((fixture.bodyBase64.length * 3) / 4) : 0);
  console.log(`  saved ${file} (${size} bytes, status ${fixture.status})`);
}

async function main(): Promise<void> {
  const dir = OUT.pathname;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const cfg: Config = loadConfig();
  const dataDir = mkdtempSync(join(tmpdir(), 'liner-artistmeta-rec-'));
  const db = openDb(':memory:');

  const realFetch = globalThis.fetch.bind(globalThis);
  let currentSlug = '';
  const imageRecords: ImageRecord[] = [];
  const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (/lyrics|genius\.com/i.test(url)) throw new Error(`refusing to fetch lyrics URL: ${url}`);
    const res = await realFetch(input, init);
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.startsWith('image/')) {
      const bytes = Buffer.from(await res.clone().arrayBuffer());
      imageRecords.push({ url, status: res.status, contentType, bytes });
    }
    return res;
  }) as typeof fetch;

  const mb = new MbClient({
    userAgent: cfg.userAgent,
    db,
    fetch: recordingFetch,
    rateLimitMs: 1000,
  });
  const artistMeta: ArtistMeta = createArtistMeta(db, { ...cfg, dataDir }, {
    fetch: recordingFetch,
    fetchBinary: recordingFetch,
    mbClient: mb,
    resizeImages: false, // fixture bytes stay exactly as downloaded
  });

  const used = new Set<string>();
  let failures = 0;

  try {
    for (const target of targets) {
      currentSlug = target.slug;
      console.log(`\n${target.name}${target.mbid ? ` (${target.mbid})` : ' (no mbid)'} — ${target.note}`);
      const artistId = target.mbid ? ids.artistByMbid(target.mbid) : ids.artistByName(target.name);
      db.prepare('INSERT OR REPLACE INTO artists (id, name, mbid) VALUES (?, ?, ?)').run(
        artistId,
        target.name,
        target.mbid ?? null,
      );

      const since = maxCacheRowid(db);
      const beforeImages = imageRecords.length;
      const info = await artistMeta.getArtistInfo(artistId, { refresh: true });
      if (!info) throw new Error(`no info object for ${target.slug}`);

      const hasBio = Boolean(info.bio?.value);
      const hasImage = Boolean(info.imagePath);
      console.log(
        `  bio=${hasBio ? `${info.bio?.value.length} chars` : 'none'} image=${hasImage ? info.imagePath?.split('/').pop() : 'none'}` +
          (info.imageCredit ? ` credit=${info.imageCredit.author ?? '?'} / ${info.imageCredit.license ?? '?'}` : ''),
      );
      if (hasBio !== target.expectBio) {
        console.log(`  !! expected bio=${target.expectBio}`);
        failures++;
      }
      if (target.expectBio && !hasImage) {
        console.log('  !! expected an image');
        failures++;
      }
      if (info.bio) {
        console.log(`  bio starts: ${info.bio.value.slice(0, 120)}`);
        if (/\[\[|\]\]|\{\{|\}\}|<ref|\{\|/.test(info.bio.value)) {
          console.log('  !! bio still contains wiki markup');
          failures++;
        }
      }

      // API responses captured by CachedHttp / MbClient.
      const rows = db
        .prepare('SELECT key, body, status FROM http_cache WHERE rowid > ? ORDER BY rowid')
        .all(since) as { key: string; body: string; status: number }[];
      for (const row of rows) {
        const kind = kindFor(row.key);
        if (!kind) continue;
        writeFixture(dir, `${target.slug}--${kind}`, { url: row.key, status: row.status, body: row.body }, used);
      }

      // Image bytes (fetched directly, outside the text cache).
      for (const img of imageRecords.slice(beforeImages)) {
        writeFixture(
          dir,
          `${target.slug}--image`,
          {
            url: img.url,
            status: img.status,
            ...(img.contentType ? { contentType: img.contentType } : {}),
            bodyBase64: img.bytes.toString('base64'),
          },
          used,
        );
      }
    }

    console.log(`\nfixtures written to ${dir}`);
    console.log(`files: ${readdirSync(dir).length}, failures: ${failures}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
