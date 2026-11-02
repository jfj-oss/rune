// Records ListenBrainz + MusicBrainz fixtures used by tests/discover.test.ts.
// This is the ONLY place that talks to LB/MB for discovery tests; the tests
// themselves replay the JSON offline.
//
//   pnpm -C server exec tsx scripts/record-discover.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

setDefaultResultOrder('ipv4first');

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'discover');
const UA = 'rune-discover-fixtures/0.1 ( personal music player, self-hosted )';
const LABS = 'https://labs.api.listenbrainz.org';
const MB = 'https://musicbrainz.org/ws/2';

const RADIOHEAD = 'a74b1b7f-71a5-4011-9441-d0b5e4122711';
const BLINDING_LIGHTS = '1a67e215-a19e-40c9-9b12-732de134bf5f';
const ARTIST_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
const RECORDING_ALGORITHM =
  'session_based_days_7500_session_300_contribution_5_threshold_15_limit_50_skip_30';

interface Fixture {
  name: string;
  url: string;
  trim?: (body: unknown) => unknown;
}

const fixtures: Fixture[] = [
  {
    name: 'lb-similar-artists.json',
    url: `${LABS}/similar-artists/json?artist_mbids=${RADIOHEAD}&algorithm=${ARTIST_ALGORITHM}`,
    trim: (body) => (Array.isArray(body) ? body.slice(0, 25) : body),
  },
  {
    name: 'lb-similar-recordings.json',
    url: `${LABS}/similar-recordings/json?recording_mbids=${BLINDING_LIGHTS}&algorithm=${RECORDING_ALGORITHM}`,
    trim: (body) => (Array.isArray(body) ? body.slice(0, 30) : body),
  },
  {
    name: 'mb-isrc.json',
    url: `${MB}/isrc/USUG11904206?fmt=json`,
  },
  {
    name: 'mb-recording-search.json',
    url: `${MB}/recording/?${new URLSearchParams({
      query: 'recording:"Blinding Lights" AND artist:"The Weeknd"',
      fmt: 'json',
      limit: '5',
    }).toString()}`,
    trim: (body) => {
      const b = body as { recordings?: Record<string, unknown>[] };
      if (!b || !Array.isArray(b.recordings)) return body;
      return {
        ...b,
        recordings: b.recordings.slice(0, 5).map((r) => ({
          id: r.id,
          title: r.title,
          score: r.score,
          length: r.length,
          'artist-credit': r['artist-credit'],
        })),
      };
    },
  },
  {
    name: 'mb-artist-search.json',
    url: `${MB}/artist/?${new URLSearchParams({
      query: 'artist:"Radiohead"',
      fmt: 'json',
      limit: '5',
    }).toString()}`,
    trim: (body) => {
      const b = body as { artists?: unknown[] };
      return b && Array.isArray(b.artists) ? { ...b, artists: b.artists.slice(0, 5) } : body;
    },
  },
];

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest: { recordedAt: string; files: Record<string, string> } = {
    recordedAt: new Date().toISOString(),
    files: {},
  };
  for (const fixture of fixtures) {
    const res = await fetchWithRetry(fixture.url);
    const text = await res.text();
    if (!res.ok) throw new Error(`${fixture.name}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as unknown;
    const output = fixture.trim ? fixture.trim(body) : body;
    writeFileSync(join(OUT, fixture.name), JSON.stringify(output, null, 2) + '\n');
    manifest.files[fixture.name] = fixture.url;
    console.log(`${fixture.name}  ${Array.isArray(output) ? `${output.length} rows` : 'ok'}`);
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

void main();
