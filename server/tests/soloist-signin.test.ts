// Soloist comes up signed in after a reboot: the first start waits for the network, and a start that still came up
// signed out is done again (with pauses, capped) until Soloist says logged_in: true. Everything is a fake here: no
// process is started, the network is never asked, and the clock and timers are the test's own.
import { describe, expect, it } from 'vitest';
import { SoloistSignIn } from '../src/soloist/signin.js';
import { SoloistSupervisor, type ChildLike } from '../src/soloist/supervisor.js';
import { soloistFallbackNotice } from '../src/soloist/pcRoute.js';

/** A clock with timers that run only when the test moves the time on. */
class Clock {
  t = 0;
  private id = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => { this.timers.set(++this.id, { at: this.t + ms, fn }); return this.id; };
  clearTimeout = (id: unknown): void => { this.timers.delete(id as number); };
  get pending(): number { return this.timers.size; }
  /** Move the time on, running what comes due in order; promise callbacks settle between the timers. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** The socket's view plus a Soloist process that signs in at its start only when `spotifyUp` (as the real one does). */
function rig(opts: { online?: boolean; spotifyUp?: boolean; maxAttempts?: number } = {}) {
  const clock = new Clock();
  const view = { connected: true, loggedIn: false };
  const listeners = new Set<() => void>();
  const logs: { msg: string; obj: Record<string, unknown> }[] = [];
  const world = { online: opts.online ?? true, spotifyUp: opts.spotifyUp ?? true, restarts: 0, probes: 0, canRestart: true };
  const set = (patch: Partial<typeof view>) => { Object.assign(view, patch); for (const f of [...listeners]) f(); };
  const signIn = new SoloistSignIn({
    view: () => view,
    onView: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    restart: () => {
      if (!world.canRestart) return false;
      world.restarts++;
      set({ connected: false, loggedIn: false });
      // The new process is up two seconds later; its one sign-in try works only when Spotify can be reached then.
      clock.setTimeout(() => { set({ connected: true, loggedIn: false }); if (world.online && world.spotifyUp) clock.setTimeout(() => set({ loggedIn: true }), 1000); }, 2000);
      return true;
    },
    online: async () => { world.probes++; return world.online; },
    graceMs: 10_000,
    backoffMs: [20_000, 30_000, 60_000],
    maxAttempts: opts.maxAttempts ?? 4,
    slowMs: 1_800_000,
    offlinePollMs: 5000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    log: (obj, msg) => logs.push({ obj, msg }),
  });
  return { clock, view, set, world, signIn, logs };
}

describe('SoloistSignIn: a Soloist that came up signed out is started again until it is signed in', () => {
  it('the boot case: signed out at the start, one restart once the grace period is over, then signed in and quiet', async () => {
    const r = rig();
    expect(r.signIn.state).toBe('waiting');
    expect(r.signIn.problem()).toMatch(/signing in/);
    await r.clock.advance(9000);
    expect(r.world.restarts).toBe(0);
    await r.clock.advance(1500);
    expect(r.world.restarts).toBe(1);
    expect(r.signIn.state).toBe('retrying');
    await r.clock.advance(4000);
    expect(r.view.loggedIn).toBe(true);
    expect(r.signIn.state).toBe('ok');
    expect(r.signIn.problem()).toBeNull();
    expect(r.signIn.attempts).toBe(0);
    // Signed in: no timer is left, and nothing more happens however long it runs.
    expect(r.clock.pending).toBe(0);
    await r.clock.advance(3_600_000);
    expect(r.world.restarts).toBe(1);
    expect(r.logs.map((l) => l.msg).join('\n')).toMatch(/restarted it[\s\S]*signed in to Spotify/);
  });

  it('a normal start is left alone: signed in within the grace period means no restart and no network probe', async () => {
    const r = rig();
    await r.clock.advance(3000);
    r.set({ loggedIn: true });
    await r.clock.advance(600_000);
    expect(r.world.restarts).toBe(0);
    expect(r.world.probes).toBe(0);
    expect(r.signIn.state).toBe('ok');
  });

  it('no network: nothing is restarted or counted, the page says so, and the restart comes when the network is back', async () => {
    const r = rig({ online: false });
    await r.clock.advance(120_000);
    expect(r.world.restarts).toBe(0);
    expect(r.signIn.attempts).toBe(0);
    expect(r.signIn.state).toBe('offline');
    expect(r.signIn.problem()).toMatch(/cannot reach Spotify/);
    // It asks at a calm pace: once every 5 s, never faster.
    expect(r.world.probes).toBeLessThanOrEqual(120_000 / 5000);
    expect(r.logs.filter((l) => /waiting for the network/.test(l.msg)).length).toBe(1);
    r.world.online = true;
    await r.clock.advance(6000);
    expect(r.world.restarts).toBe(1);
    await r.clock.advance(4000);
    expect(r.signIn.state).toBe('ok');
  });

  it('never loops fast and is capped: growing pauses, then plain words about pairing and one try every half hour', async () => {
    const r = rig({ spotifyUp: false, maxAttempts: 4 });
    const at: number[] = [];
    let seen = 0;
    for (let i = 0; i < 600; i++) {
      await r.clock.advance(1000);
      if (r.world.restarts > seen) { seen = r.world.restarts; at.push(r.clock.t); }
    }
    // Ten minutes: the four capped restarts and no more, each pause at least as long as the one before, none under 10 s.
    expect(at.length).toBe(4);
    const gaps = at.map((t, i) => t - (at[i - 1] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10_000);
    for (let i = 2; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    expect(r.signIn.problem()).toMatch(/could not sign in to Spotify after 4 tries.*soloist --pair.*every 30 minutes/);
    expect(soloistFallbackNotice({ run: 'running', connected: true, loggedIn: false, problem: r.signIn.problem() })).toMatch(/after 4 tries.*using the Spotify app/);
    // Every restart was logged with its number.
    expect(r.logs.filter((l) => /restarted it/.test(l.msg)).map((l) => l.obj.attempt)).toEqual([1, 2, 3, 4]);
    // The slow rhythm: one more per half hour, and it still recovers by itself when Spotify works again.
    await r.clock.advance(1_800_000);
    expect(r.world.restarts).toBe(5);
    expect(r.signIn.state).toBe('needs-sign-in');
    r.world.spotifyUp = true;
    await r.clock.advance(1_800_000);
    expect(r.world.restarts).toBe(6);
    await r.clock.advance(5000);
    expect(r.signIn.state).toBe('ok');
    expect(r.signIn.attempts).toBe(0);
  });

  it('a Soloist that is not running (crashed, between two starts) is the supervisor\'s business: no restart from here', async () => {
    const r = rig();
    r.set({ connected: false });
    r.world.canRestart = false;
    await r.clock.advance(300_000);
    expect(r.world.restarts).toBe(0);
    expect(r.signIn.attempts).toBe(0);
    // Back and signed out: the grace period starts over from the moment it is connected again.
    r.world.canRestart = true;
    r.set({ connected: true });
    const t0 = r.clock.t;
    await r.clock.advance(9000);
    expect(r.world.restarts).toBe(0);
    await r.clock.advance(6000);
    expect(r.world.restarts).toBe(1);
    expect(r.clock.t - t0).toBeLessThanOrEqual(15_000);
  });

  it('a sign-out later on (Soloist was signed in for hours) is repaired the same way; close() stops everything', async () => {
    const r = rig();
    r.set({ loggedIn: true });
    await r.clock.advance(7_200_000);
    r.set({ loggedIn: false });
    await r.clock.advance(11_000);
    expect(r.world.restarts).toBe(1);
    await r.clock.advance(4000);
    expect(r.signIn.state).toBe('ok');
    r.set({ loggedIn: false });
    r.signIn.close();
    await r.clock.advance(600_000);
    expect(r.world.restarts).toBe(1);
    expect(r.clock.pending).toBe(0);
  });
});

describe('SoloistSupervisor: the first start waits for the network, and restart() is not a crash', () => {
  interface FakeChild extends ChildLike { exit(code: number | null): void; signals: string[] }
  const makeChild = (): FakeChild => {
    const handlers: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
    const signals: string[] = [];
    return {
      pid: 1,
      signals,
      kill: (s?: NodeJS.Signals) => { signals.push(s ?? 'SIGTERM'); return true; },
      on(event: string, fn: never) { if (event === 'exit') handlers.push(fn); return this; },
      exit(code) { for (const h of handlers) h(code, null); },
    } as FakeChild;
  };
  const make = (extra: { online?: () => Promise<boolean>; startWaitMs?: number } = {}) => {
    const clock = new Clock();
    const spawned: FakeChild[] = [];
    const logs: string[] = [];
    const sup = new SoloistSupervisor({
      binary: '/bin/soloist', keyFile: '/k', deviceName: 'rune', ws: '127.0.0.1:4547',
      exists: () => true,
      readKey: () => 'SECRET-KEY',
      spawn: () => { const c = makeChild(); spawned.push(c); return c; },
      setTimeout: clock.setTimeout,
      now: clock.now,
      log: (obj, msg) => logs.push(`${msg} ${JSON.stringify(obj)}`),
      ...extra,
    });
    return { clock, spawned, logs, sup };
  };

  it('does not start Soloist before the network answers (it signs in only once, at its start)', async () => {
    let online = false;
    const t = make({ online: async () => online });
    t.sup.start();
    expect(t.sup.run).toBe('starting');
    await t.clock.advance(20_000);
    expect(t.spawned.length).toBe(0);
    expect(t.logs.filter((l) => /waiting for the network/.test(l)).length).toBe(1);
    online = true;
    await t.clock.advance(2500);
    expect(t.spawned.length).toBe(1);
    expect(t.sup.run).toBe('running');
    t.sup.stop();
  });

  it('starts at once when the network is there, and anyway after the cap when it never comes', async () => {
    const up = make({ online: async () => true });
    up.sup.start();
    await settle();
    expect(up.spawned.length).toBe(1);
    up.sup.stop();

    const down = make({ online: async () => { throw new Error('resolver broke'); }, startWaitMs: 30_000 });
    down.sup.start();
    await down.clock.advance(29_000);
    expect(down.spawned.length).toBe(0);
    await down.clock.advance(3000);
    expect(down.spawned.length).toBe(1);
    expect(down.logs.join('\n')).toMatch(/starting it anyway/);
    expect(down.logs.join('\n')).not.toContain('SECRET-KEY');
    down.sup.stop();
  });

  it('stop() while it waits: nothing is ever started', async () => {
    const t = make({ online: async () => false });
    t.sup.start();
    await t.clock.advance(5000);
    t.sup.stop();
    await t.clock.advance(120_000);
    expect(t.spawned.length).toBe(0);
    expect(t.sup.run).toBe('off');
  });

  it('restart(): SIGTERM, a new start after the old one is gone, never shown as a crash; SIGKILL when it will not go', async () => {
    const t = make();
    t.sup.start();
    expect(t.sup.restart('test')).toBe(true);
    expect(t.spawned[0]!.signals).toEqual(['SIGTERM']);
    expect(t.sup.run).toBe('starting');
    expect(t.sup.problem()).toBeNull();
    // A second call while the first is under way does nothing.
    expect(t.sup.restart('again')).toBe(false);
    await t.clock.advance(500);
    expect(t.spawned.length).toBe(1);
    t.spawned[0]!.exit(0);
    expect(t.sup.run).toBe('starting');
    await t.clock.advance(1100);
    expect(t.spawned.length).toBe(2);
    expect(t.sup.run).toBe('running');

    // One that ignores SIGTERM is killed after five seconds, and the new one starts once it is really gone.
    expect(t.sup.restart('stuck')).toBe(true);
    await t.clock.advance(6000);
    expect(t.spawned[1]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(t.spawned.length).toBe(2);
    t.spawned[1]!.exit(null);
    await t.clock.advance(1100);
    expect(t.spawned.length).toBe(3);

    // An expired build found on the way is still the end, and nothing running means nothing to restart.
    t.sup.restart('expired underneath');
    t.spawned[2]!.exit(10);
    expect(t.sup.run).toBe('expired');
    expect(t.sup.restart('nothing there')).toBe(false);
    await t.clock.advance(120_000);
    expect(t.spawned.length).toBe(3);
    t.sup.stop();
  });
});
