// A real silent rune server (temp data dir, own port) with a GENERATED library, for the native desktop app: screenshots next to
// the web UI, the e2e that drives it, and the scroll benchmark.
//   RUNE_DESKTOP_ALBUMS=60 (default) | 3000 for the benchmark     RUNE_DESKTOP_PORT=4599     RUNE_DESKTOP_LIB=<dir kept between runs>
// `npx tsx tests/e2e/desktopServe.ts` prints `READY http://127.0.0.1:<port>` and runs until SIGTERM/SIGINT.
// Nothing is audible (mpv on a null output), nothing touches the live rune, its DB, port 4545 or the user's music, and
// there is no Spotify client id (so no Spotify call can be made).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../src/config.js';
import { buildApp } from '../../src/api/server.js';
import { openDb } from '../../src/db/index.js';
import { createScanner } from '../../src/scan/index.js';

process.env.LOG_LEVEL = 'silent';
const N = Number(process.env.RUNE_DESKTOP_ALBUMS ?? 60);
const PORT = Number(process.env.RUNE_DESKTOP_PORT ?? 0);
const keep = process.env.RUNE_DESKTOP_LIB;
const dir = keep ?? mkdtempSync(join(tmpdir(), 'rune-desktop-'));
const libRoot = join(dir, 'music');
const dataDir = join(dir, 'data');
mkdirSync(libRoot, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// -------- a deterministic generator (the same names every run, so web and native show the same pages)
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
const W1 = ['Glass', 'Velvet', 'Paper', 'Iron', 'Silent', 'Golden', 'Hollow', 'Electric', 'Winter', 'Neon', 'Broken', 'Distant', 'Ocean', 'Midnight', 'Copper', 'Slow', 'Violet', 'Northern', 'Wild', 'Lost'];
const W2 = ['Harbour', 'Garden', 'Machine', 'Season', 'Orbit', 'Letters', 'Rooms', 'Weather', 'Signals', 'Mirrors', 'Horizon', 'Engine', 'Fields', 'Anthem', 'Tides', 'Atlas', 'Bloom', 'Static', 'Hours', 'Parade'];
const ARTISTS = ['The Lanterns', 'Mira Okonkwo', 'Halden & Rowe', 'Static Orchard', 'Juno Park', 'Ten Thousand Birds', 'Caro Lindqvist', 'Brass Meridian', 'Oda Fenwick', 'A Very Long Artist Name That Will Not Fit In A Card At Any Width', 'Sable', 'Tomas Reyes Quartet', 'Pale Fire Department', 'Ivy Chen', 'Low Tide Club', 'Marlowe', 'Nightingale Express', 'Dot Matrix Choir', 'Fenn', 'The Understudies'];
const GENRES = ['Rock', 'Jazz', 'Electronic', 'Folk', 'Ambient', 'Soul', 'Classical', 'Hip-Hop'];

const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => { const p = spawn(cmd, args, { stdio: 'ignore' }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${cmd} ${c}`)))); p.on('error', rej); });
async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await f(items[i++]!); })); }

async function writeLibrary() {
  const marker = join(libRoot, '.generated');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === String(N)) return;
  const tmp = join(dir, 'tmp'); mkdirSync(tmp, { recursive: true });
  const base = join(tmp, 'base.flac');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '30', '-c:a', 'flac', base]);
  const covers: string[] = [];
  for (let i = 0; i < 40; i++) {
    const f = join(tmp, `cover${i}.jpg`);
    covers.push(f);
  }
  await pool(covers, 8, (f) => { const i = covers.indexOf(f); const c = (k: number) => '0x' + ((Math.floor((Math.sin(i * 12.9 + k) * 0.5 + 0.5) * 0xffffff)) & 0xffffff).toString(16).padStart(6, '0');
    return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=600x600:c0=${c(1)}:c1=${c(2)}:c2=${c(3)}:x0=${(i * 37) % 600}:y0=0:x1=${600 - ((i * 53) % 600)}:y1=600:nb_colors=3:seed=${i}:d=1`, '-frames:v', '1', '-q:v', '3', f]); });
  type T = { path: string; meta: string[] };
  const jobs: { dir: string; file: string; meta: string[] }[] = [];
  const albumDirs: { dir: string; cover: string }[] = [];
  for (let a = 0; a < N; a++) {
    const artist = a === 0 ? 'E2E Artist' : ARTISTS[a % ARTISTS.length]!;
    const title = a === 0 ? 'Alpha' : a === 1 ? 'An Album With A Remarkably Long Title That Must Be Cut Short' : `${W1[a % W1.length]} ${W2[Math.floor(a / W1.length + a) % W2.length]}${a >= 400 ? ` ${Math.floor(a / 400) + 1}` : ''}`;
    const year = 1968 + ((a * 7) % 55);
    const nt = a === 2 ? 14 : 3 + (a % 8);
    const multi = a === 3;
    const adir = join(libRoot, artist.replace(/\//g, '-'), `${title} (${a})`);
    mkdirSync(adir, { recursive: true });
    albumDirs.push({ dir: adir, cover: covers[a % covers.length]! });
    for (let t = 0; t < nt; t++) {
      const disc = multi ? 1 + Math.floor(t / 3) : 1;
      const num = multi ? (t % 3) + 1 : t + 1;
      const feat = a % 5 === 0 && t % 3 === 1;
      jobs.push({ dir: adir, file: `${String(t + 1).padStart(2, '0')} track.flac`, meta: [`title=${t === 0 ? 'Opening' : `${pick(W1)} ${pick(W2)}`}${t === 4 && a % 4 === 0 ? ' (a rather long track title for the ellipsis test)' : ''}`, `artist=${feat ? artist + ' feat. Guest' : artist}`, `album=${title}`, `album_artist=${artist}`, `track=${num}`, `disc=${disc}`, `date=${year}`, `genre=${GENRES[a % GENRES.length]}`] });
    }
  }
  await pool(albumDirs, 8, async (d) => { await run('cp', [d.cover, join(d.dir, 'folder.jpg')]); });
  await pool(jobs, 8, (j) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', base, '-t', String(2 + Math.floor(rnd() * 5)), '-c:a', 'copy', ...j.meta.flatMap((m) => ['-metadata', m]), join(j.dir, j.file)]));
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(marker, String(N));
}

await writeLibrary();
const cfg: Config = { libraryRoots: [libRoot], dataDir, port: PORT, audioDevice: 'null', userAgent: 'rune-desktop-e2e', normalize: 'off', pcSpotifyDevice: 'rune-desktop-none' };
const db = openDb(join(dataDir, 'liner.db'));
await createScanner(db, cfg).scan();
const built = await buildApp(db, cfg, { pcZone: true, scanOnStart: false, watch: false, backups: false, ...(process.env.RUNE_DESKTOP_WEB ? { webDist: process.env.RUNE_DESKTOP_WEB } : {}) });
await built.app.listen({ host: '127.0.0.1', port: PORT });
const port = (built.app.server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
// a few playlists, a pin, so the pages are not empty
const post = (p: string, b: unknown, m = 'POST') => fetch(`${base}/api${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const albums = (await (await fetch(`${base}/api/library/albums?limit=40&sort=title`)).json()) as { items: { id: string }[] };
const first = albums.items.slice(0, 6);
const trackIds: string[] = [];
for (const a of first) { const d = (await (await fetch(`${base}/api/albums/${encodeURIComponent(a.id)}`)).json()) as { tracks: { id: string }[] }; trackIds.push(...d.tracks.map((t) => t.id)); }
const pl1 = (await post('/playlists', { name: 'Road trip' })) as { id: string };
await post(`/playlists/${encodeURIComponent(pl1.id)}/tracks`, { trackIds: trackIds.slice(0, 18) });
const pl2 = (await post('/playlists', { name: 'Late night' })) as { id: string };
await post(`/playlists/${encodeURIComponent(pl2.id)}/tracks`, { trackIds: trackIds.slice(10, 24) });
if (first[1]) await fetch(`${base}/api/pins/${encodeURIComponent(first[1].id)}`, { method: 'PUT' });
console.log(`READY ${base}`);
const stop = async () => { await built.shutdown('desktopServe').catch(() => undefined); if (!keep) rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => undefined, 1 << 30);
