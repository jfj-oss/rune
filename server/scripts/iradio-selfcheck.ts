// Worker Y self-check against the real radio-browser API and real mpv.
//
//  1. search "jazz" and "BBC",
//  2. resolve three stations by uuid,
//  3. play one for 15 s through a real mpv with --ao=null (silent) in a test PC
//     zone and print the ICY "now playing" titles mpv reports,
//  4. proxy the same station through GET /radio/:id/stream for 10 s and report
//     the bytes received.
//
// Run: pnpm -C server exec tsx scripts/iradio-selfcheck.ts
// Network is used here (and only here / in the fixture recorder).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createIradio, registerRadioStationRoutes } from '../src/iradio/index.js';
import { createPcZone, type PcZone } from '../src/play/zone.js';

const dataDir = mkdtempSync(join(tmpdir(), 'liner-iradio-selfcheck-'));
const cfg: Config = {
  libraryRoots: [],
  dataDir,
  port: 0,
  audioDevice: 'null',
  userAgent: 'Liner/0.1 ( personal music player, self-hosted; radio self-check )',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const db = openDb(':memory:');
const iradio = createIradio(db, cfg);
let zone: PcZone | undefined;
let app: FastifyInstance | undefined;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

try {
  console.log('== search ==');
  const jazz = await iradio.search({ q: 'jazz', limit: 10 });
  console.log(`jazz: ${jazz.total} stations; first: ${jazz.items[0]?.name}`);
  for (const s of jazz.items.slice(0, 3)) {
    console.log(`  ${s.id}  votes=${s.votes} clicks=${s.clickcount}  ${s.name}  [${s.codec} ${s.bitrate}]`);
  }
  const bbc = await iradio.search({ q: 'BBC', limit: 10 });
  console.log(`BBC: ${bbc.total} stations; first: ${bbc.items[0]?.name}`);
  for (const s of bbc.items.slice(0, 3)) {
    console.log(`  ${s.id}  votes=${s.votes} clicks=${s.clickcount}  ${s.name}  [${s.codec} ${s.bitrate}]`);
  }

  console.log('\n== resolve three stations (GET /radio/:id equivalent) ==');
  const picks = [
    jazz.items[0],
    jazz.items[1],
    bbc.items[0],
  ].filter((s): s is NonNullable<typeof s> => s !== undefined);
  if (picks.length < 3) throw new Error(`only resolved ${picks.length} stations`);
  for (const pick of picks) {
    const resolved = await iradio.station(pick.id);
    console.log(`  ${pick.id} -> ${resolved?.name} (${resolved?.urlResolved ?? resolved?.url})`);
  }

  console.log('\n== PC zone: 15 s through real mpv --ao=null ==');
  const chose = picks[0]!;
  console.log(`playing ${chose.name} (${chose.id}) at ${chose.urlResolved ?? chose.url}`);
  zone = await createPcZone(db, cfg);
  console.log(`mpv pid ${zone.mpvPid()}`);

  const titles: string[] = [];
  const seenTitles = new Set<string>();
  zone.onChange((state) => {
    const np = state.nowPlaying;
    if (!np) return;
    const line = [np.artist, np.title].filter(Boolean).join(' - ') || '(no title)';
    const signature = `${line} [${np.station ?? ''}]`;
    if (!seenTitles.has(signature)) {
      seenTitles.add(signature);
      titles.push(signature);
      console.log(`  [${stamp()}] ICY now playing: ${signature}`);
    }
  });

  const started = Date.now();
  const initial = await zone.command({ type: 'play', trackIds: [chose.id] });
  console.log(
    `play -> status=${initial.status} index=${initial.index} signal=${(initial.signalPath ?? []).join(' > ')}`,
  );
  let firstPosition: number | undefined;
  let lastPosition = 0;
  let lastStatus = initial.status;
  while (Date.now() - started < 15_000) {
    await sleep(250);
    const state = zone.state();
    lastStatus = state.status;
    if (state.positionMs > 0) {
      firstPosition ??= state.positionMs;
      lastPosition = state.positionMs;
    }
  }
  console.log(
    `after 15 s: status=${lastStatus} position ${firstPosition ?? 0} ms -> ${lastPosition} ms (live stream counts up)`,
  );
  console.log(`distinct ICY titles captured: ${titles.length}`);
  for (const title of titles) console.log(`  - ${title}`);
  if (titles.length === 0) console.log('  (this station did not send icy-title metadata)');

  const nowPlaying = zone.state().nowPlaying;
  console.log('state.nowPlaying at the end:', JSON.stringify(nowPlaying));

  await zone.close();
  zone = undefined;

  console.log('\n== browser proxy: 10 s through GET /radio/:id/stream ==');
  app = Fastify({ logger: false });
  registerRadioStationRoutes(app, iradio);
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const response = await fetch(`${base}/radio/${encodeURIComponent(chose.id)}/stream`, {
    signal: controller.signal,
  });
  console.log(
    `proxy -> HTTP ${response.status} content-type=${response.headers.get('content-type')} accept-ranges=${response.headers.get('accept-ranges')}`,
  );
  const reader = response.body!.getReader();
  let bytes = 0;
  const proxyStarted = Date.now();
  const proxyDeadline = proxyStarted + 10_000;
  try {
    for (;;) {
      const remaining = proxyDeadline - Date.now();
      if (remaining <= 0) break;
      // Race the read so a stalled upstream cannot stretch the measurement.
      const next = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => null),
      ]);
      if (!next || next.done) break;
      if (next.value) bytes += next.value.length;
    }
  } catch {
    // abort below
  }
  controller.abort();
  const seconds = (Date.now() - proxyStarted) / 1000;
  console.log(`proxied ${bytes} bytes in ${seconds.toFixed(1)} s (${(bytes / seconds).toFixed(0)} B/s)`);
  if (bytes === 0) throw new Error('proxy received no bytes');

  console.log('\nself-check OK');
} catch (err) {
  console.error('self-check FAILED:', err);
  process.exitCode = 1;
} finally {
  await zone?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  iradio.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}
