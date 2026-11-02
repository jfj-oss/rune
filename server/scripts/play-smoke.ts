// End-to-end smoke test for the PC zone against a real mpv.
//
//   pnpm -C server exec tsx scripts/play-smoke.ts
//
// Uses --ao=null so nothing is played on the user's speakers. Generates three
// 4-second tones in a temp dir (the middle one is a cue slice of a 10 s file),
// drives playback, pauses/resumes/seeks, kills mpv to exercise respawn, and
// verifies close() leaves no mpv process behind.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlayerState } from '@liner/shared';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createPcZone, type PcZone } from '../src/play/zone.js';

const failures: string[] = [];
const transitions: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}

function ffmpegTone(path: string, seconds: number, freq: number): void {
  const res = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${freq}:duration=${seconds}`,
      '-c:a',
      'flac',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'liner-smoke-'));
  const cfg = {
    ...loadConfig(),
    libraryRoots: [],
    dataDir: join(dir, 'data'),
    port: 0,
    audioDevice: 'null', // never touch the speakers
  };

  const track1 = join(dir, 'tone1.flac');
  const big = join(dir, 'big10.flac');
  const track3 = join(dir, 'tone3.flac');
  ffmpegTone(track1, 4, 440);
  ffmpegTone(big, 10, 330);
  ffmpegTone(track3, 4, 660);

  const db = openDb(':memory:');
  db.prepare("INSERT INTO artists (id, name) VALUES ('ar:smoke', 'Smoke Artist')").run();
  db.prepare(
    "INSERT INTO albums (id, source, title, artist_id, added_at) VALUES ('la:smoke', 'local', 'Smoke Album', 'ar:smoke', 0)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO tracks (id, album_id, source, title, disc, number, duration_ms, path,
       cue_start_ms, cue_end_ms, format, sample_rate, bit_depth)
     VALUES (?, 'la:smoke', 'local', ?, 1, ?, ?, ?, ?, ?, 'flac', 44100, 16)`,
  );
  insert.run('l:smoke1', 'Tone One', 1, 4000, track1, null, null);
  insert.run('l:smoke2', 'Cue Slice', 2, 4000, big, 2000, 6000);
  insert.run('l:smoke3', 'Tone Three', 3, 4000, track3, null, null);

  let zone: PcZone | undefined;
  let lastSignature = '';
  let lastState: PlayerState | undefined;

  const waitFor = async (
    description: string,
    predicate: (s: PlayerState) => boolean,
    timeoutMs = 15_000,
  ): Promise<PlayerState> => {
    const deadline = Date.now() + timeoutMs;
    let state = zone!.state();
    while (!predicate(state)) {
      if (Date.now() > deadline) {
        throw new Error(
          `timeout waiting for ${description}; last state: ${JSON.stringify({
            status: state.status,
            index: state.index,
            positionMs: state.positionMs,
            queue: state.queue.length,
          })}`,
        );
      }
      await sleep(50);
      state = zone!.state();
    }
    return state;
  };

  try {
    console.log('smoke: starting real mpv with --ao=null');
    zone = await createPcZone(db, cfg);
    const initialPid = zone.mpvPid();
    check(initialPid !== undefined && isAlive(initialPid), `mpv is running (pid ${initialPid})`);

    zone.onChange((s) => {
      lastState = s;
      const signature = `${s.status} index=${s.index} vol=${s.volume}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        const line = `${((Date.now() - started) / 1000).toFixed(1)}s ${signature} pos=${s.positionMs} signal=${(s.signalPath ?? []).join(' > ')}`;
        console.log(`  state ${line}`);
        if (signature.startsWith('playing') || signature.startsWith('paused') || signature.startsWith('stopped')) {
          transitions.push(`${signature} (pos ${s.positionMs})`);
        }
      }
    });

    console.log('smoke: playing three tracks');
    let state = await zone.command({
      type: 'play',
      trackIds: ['l:smoke1', 'l:smoke2', 'l:smoke3'],
    });
    check(state.queue.length === 3 && state.index === 0, 'queue has 3 items, index 0');
    state = await waitFor('playing track 0', (s) => s.status === 'playing' && s.index === 0);
    check((state.signalPath ?? []).includes('mpv'), 'signal path includes mpv');
    state = await waitFor('audio output params', (s) =>
      (s.signalPath ?? []).some((part) => part.startsWith('null output')),
    );
    check(
      (state.signalPath ?? []).some((part) => part.startsWith('null output')),
      'signal path names the null output',
    );

    const advanced = await waitFor('position to advance', (s) => s.positionMs > 800);
    check(advanced.positionMs > 800, `position advanced to ${advanced.positionMs} ms`);

    await zone.command({ type: 'volume', volume: 80 });
    state = await waitFor('volume 80 state', (s) => s.volume === 80);
    check((state.signalPath ?? []).includes('volume 80%'), 'signal path reports volume 80%');
    await zone.command({ type: 'volume', volume: 100 });

    console.log('smoke: waiting for automatic transition 0 -> 1');
    state = await waitFor('playing track 1', (s) => s.status === 'playing' && s.index === 1);
    check(true, `auto-advanced to index 1 (pos ${state.positionMs} ms, signal ${(state.signalPath ?? []).join(' > ')})`);
    check((state.signalPath ?? [])[0] === 'FLAC 16/44.1', 'cue track signal path starts with FLAC 16/44.1');

    await waitFor('cue slice position', (s) => s.index === 1 && s.positionMs > 900 && s.positionMs < 3000);

    console.log('smoke: pause / resume / seek');
    await zone.command({ type: 'pause' });
    state = await waitFor('paused', (s) => s.status === 'paused');
    const pausedAt = state.positionMs;
    await sleep(600);
    state = zone.state();
    check(state.status === 'paused', 'still paused after 600 ms');
    check(Math.abs(state.positionMs - pausedAt) < 100, `position frozen while paused (${pausedAt} -> ${state.positionMs})`);

    await zone.command({ type: 'resume' });
    state = await waitFor('playing after resume', (s) => s.status === 'playing');
    check(true, 'resume returned to playing');

    await zone.command({ type: 'seek', positionMs: 1500 });
    state = await waitFor('seek to 1500 ms', (s) => Math.abs(s.positionMs - 1500) < 400);
    check(true, `seek landed at ${state.positionMs} ms`);

    console.log('smoke: prev after >3 s restarts the track');
    await zone.command({ type: 'pause' });
    await waitFor('paused before prev', (s) => s.status === 'paused');
    await zone.command({ type: 'seek', positionMs: 3500 });
    state = await waitFor('seek to 3500 ms while paused', (s) => Math.abs(s.positionMs - 3500) < 400);
    await zone.command({ type: 'prev' });
    state = await waitFor('restart after prev', (s) => s.index === 1 && s.positionMs < 800);
    check(true, `prev restarted track 1 (pos ${state.positionMs} ms, was near 3.5 s)`);
    await zone.command({ type: 'resume' });
    await waitFor('playing after prev restart', (s) => s.status === 'playing');

    console.log('smoke: waiting for automatic transition 1 -> 2');
    state = await waitFor('playing track 2', (s) => s.status === 'playing' && s.index === 2, 20_000);
    check(true, `auto-advanced to index 2 (pos ${state.positionMs} ms)`);

    await waitFor('track 2 to advance before the kill', (s) => s.index === 2 && s.positionMs > 800);
    console.log('smoke: killing mpv to exercise respawn');
    const killedPid = zone.mpvPid();
    const beforeKillPos = zone.state().positionMs;
    check(killedPid !== undefined, `captured mpv pid ${killedPid}`);
    process.kill(killedPid!, 'SIGKILL');
    const afterRespawn = await waitFor(
      'respawn recovery',
      (s) => s.status === 'playing' && s.index === 2 && zone!.mpvPid() !== killedPid && zone!.mpvPid() !== undefined,
      20_000,
    );
    const newPid = zone.mpvPid();
    check(afterRespawn.index === 2, `playback recovered on index 2 after respawn (pid ${newPid})`);
    check(beforeKillPos > 500, `pre-kill position was ${beforeKillPos} ms (> 500 ms)`);
    check(
      Math.abs(afterRespawn.positionMs - beforeKillPos) < 1_500,
      `position restored near pre-kill value (${beforeKillPos} -> ${afterRespawn.positionMs} ms)`,
    );
    await sleep(600);
    check(
      zone.state().positionMs > beforeKillPos,
      `restored playback keeps advancing after respawn (${zone.state().positionMs} ms)`,
    );

    await zone.command({ type: 'pause' });
    await waitFor('paused before close', (s) => s.status === 'paused');
    const finalPid = zone.mpvPid();
    console.log(`smoke: closing zone (mpv pid ${finalPid})`);
    await zone.close();
    check(finalPid === undefined || !isAlive(finalPid), `mpv process ${finalPid} is gone after close()`);
    check(!existsSync(join(cfg.dataDir, 'mpv.sock')), 'ipc socket removed after close()');

    const last = zone.state();
    check(last.status === 'paused' || last.status === 'stopped', 'state() is still readable after close');
  } finally {
    if (zone) {
      try {
        await zone.close();
      } catch {
        // already closed
      }
    }
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n--- smoke summary ---');
  console.log(`transitions: ${transitions.join(' | ')}`);
  console.log(`last state: ${JSON.stringify({
    status: lastState?.status,
    index: lastState?.index,
    positionMs: lastState?.positionMs,
    signalPath: lastState?.signalPath,
  })}`);
  if (failures.length > 0) {
    console.error(`SMOKE FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exitCode = 1;
  } else {
    console.log('SMOKE PASSED');
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exitCode = 1;
});
