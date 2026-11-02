// Records real radio-browser.info responses for the offline unit tests. Network
// access lives here only; the tests replay these JSON files.
//
// Run: pnpm -C server exec tsx scripts/record-iradio-fixtures.ts
//
// Output (tests/fixtures/iradio/):
//   servers.json              /json/servers
//   search-jazz.json          /json/stations/search?name=jazz...
//   search-bbc.json           /json/stations/search?name=BBC...
//   byuuid/<stationuuid>.json /json/stations/byuuid/<uuid>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RadioBrowserStation } from '../src/iradio/types.js';

const OUT = new URL('../tests/fixtures/iradio/', import.meta.url);
const UA = 'Liner/0.1 ( personal music player, self-hosted; radio-browser fixture recorder )';
const SPACING_MS = 1_100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
async function get(url: string): Promise<unknown> {
  const wait = SPACING_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function searchUrl(base: string, name: string): string {
  const qs = new URLSearchParams({
    hidebroken: 'true',
    limit: '10',
    offset: '0',
    order: 'votes',
    reverse: 'true',
    name,
  });
  return `${base}/json/stations/search?${qs}`;
}

function write(relative: string, value: unknown): void {
  const file = join(OUT.pathname, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  console.log(`wrote ${relative}`);
}

const servers = (await get('https://all.api.radio-browser.info/json/servers')) as {
  name?: string;
}[];
write('servers.json', servers);
const base = `https://${servers.find((s) => typeof s.name === 'string')?.name ?? 'de1.api.radio-browser.info'}`;
console.log(`using ${base}`);

const searches: Record<string, RadioBrowserStation[]> = {};
for (const [slug, name] of [
  ['jazz', 'jazz'],
  ['bbc', 'BBC'],
] as const) {
  const stations = (await get(searchUrl(base, name))) as RadioBrowserStation[];
  searches[slug] = stations;
  write(`search-${slug}.json`, stations);
  console.log(`  ${slug}: ${stations.length} stations`);
}

const seen = new Set<string>();
for (const stations of Object.values(searches)) {
  for (const station of stations) {
    if (seen.has(station.stationuuid)) continue;
    seen.add(station.stationuuid);
    const body = await get(
      `${base}/json/stations/byuuid/${encodeURIComponent(station.stationuuid)}`,
    );
    write(join('byuuid', `${station.stationuuid}.json`), body);
  }
}

console.log(`done: ${seen.size} station records`);
