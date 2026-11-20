// A real silent rune server (temp data dir, own port) for looking at the rune mini panel by hand or in screenshots:
// `npx tsx tests/e2e/miniServe.ts` prints the URL and keeps a paused queue with cover art. Ctrl-C / SIGTERM stops it.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, until } from './rig.js';

process.env.LOG_LEVEL = 'silent';
const srv = await startServer(process.env.RUNE_MINI_WEB ? { webDist: process.env.RUNE_MINI_WEB } : {});
for (const [i, album] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=600x600:r=1,hue=h=${i * 90}`, '-frames:v', '1', join(srv.library.root, 'E2E Artist', album, 'folder.jpg')]);
}
await fetch(`${srv.base}/api/scan`, { method: 'POST' });
await until('covers', async () => (await fetch(`${srv.base}/api/cover/${encodeURIComponent(srv.library.alpha.id)}?size=200`)).headers.get('content-type')?.startsWith('image'), 20_000).catch(() => undefined);
const ids = [...srv.library.bravo.tracks, ...srv.library.alpha.tracks, ...srv.library.charlie.tracks].map((t) => t.id);
await srv.send('pc', { type: 'play', trackIds: ids, startIndex: 0, paused: true });
await srv.send('pc', { type: 'volume', volume: 70 });
if (process.env.RUNE_MINI_PLAYLISTS) {
  // a few rune playlists, all chosen for the mini (for screenshots of the dots)
  const mk = async (name: string, trackIds: string[]) => {
    const made = await (await fetch(`${srv.base}/api/playlists`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })).json() as { id: string };
    await fetch(`${srv.base}/api/playlists/${encodeURIComponent(made.id)}/tracks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trackIds }) });
    await fetch(`${srv.base}/api/mini/playlists/${encodeURIComponent(made.id)}`, { method: 'PUT' });
  };
  const names = (process.env.RUNE_MINI_PLAYLISTS === '1' ? 'Morning Drive,Late Night,Focus,Sunday Records' : process.env.RUNE_MINI_PLAYLISTS!).split(',');
  const pools = [srv.library.alpha.tracks, srv.library.bravo.tracks, srv.library.charlie.tracks];
  for (const [i, name] of names.entries()) await mk(name, pools[i % 3]!.map((t) => t.id));
}
console.log(`READY ${srv.base}`);
const stop = async () => { await srv.stop(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => undefined, 1 << 30);
