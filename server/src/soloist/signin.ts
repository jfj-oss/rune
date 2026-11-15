// Keeps Soloist signed in to Spotify without anyone doing anything.
//
// Soloist restores its saved Spotify session from its data directory when it starts and tries the sign-in ONCE. When
// that one try fails (seen after a reboot: rune started it a second after the network came up, DNS did not answer
// yet) it reports `logged_in: false` and never tries again; only a new start does. This watchdog is that new start:
// while the socket is connected and Soloist says it is signed out, it waits for the network and restarts Soloist,
// with growing pauses, until it says `logged_in: true`.
//
// It never loops fast: the first restart comes after a grace period, each next one after a longer pause, and after
// `maxAttempts` restarts with the network up it says so in plain words (a real sign-out needs `soloist --pair`) and
// only tries again every half hour. No network: nothing is restarted and nothing is counted (it would fail the same way).
import { lookup } from 'node:dns/promises';

export type SignInState = 'ok' | 'waiting' | 'offline' | 'retrying' | 'needs-sign-in';

export interface SignInOptions {
  /** What the socket says now. */
  view(): { connected: boolean; loggedIn: boolean };
  /** Called on every change of the view; returns the unsubscribe. */
  onView(fn: () => void): () => void;
  /** Stop Soloist and start it again; false when there is no running process (the supervisor is already on it). */
  restart(reason: string): boolean;
  /** Can Spotify be reached? Never throws. */
  online(): Promise<boolean>;
  /** Soloist must have been connected and signed out for this long before anything is done (default 12 s). */
  graceMs?: number;
  /** The pause after the 1st, 2nd, … restart before the next one. */
  backoffMs?: number[];
  /** Restarts (with the network up) before it is called a real sign-out (default 6). */
  maxAttempts?: number;
  /** After that: one try this often (default 30 min). */
  slowMs?: number;
  /** How often the network is asked for while it is down (default 5 s). */
  offlinePollMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  log?: (obj: Record<string, unknown>, msg: string) => void;
}

const BACKOFF_MS = [20_000, 30_000, 60_000, 120_000, 300_000];

export class SoloistSignIn {
  state: SignInState = 'ok';
  /** Restarts made since Soloist was last signed in. */
  attempts = 0;
  private timer: unknown = null;
  private busy = false;
  private closed = false;
  /** Since when the socket has been connected and signed out without a break; null otherwise. */
  private signedOutSince: number | null = null;
  private readonly off: () => void;
  private readonly now: () => number;
  private readonly grace: number;
  private readonly max: number;

  constructor(private readonly opts: SignInOptions) {
    this.now = opts.now ?? Date.now;
    this.grace = opts.graceMs ?? 12_000;
    this.max = opts.maxAttempts ?? 6;
    this.off = opts.onView(() => this.evaluate());
    this.evaluate();
  }

  close(): void {
    this.closed = true;
    this.off();
    this.disarm();
  }

  /** One line for the page while Soloist is signed out, or null when there is nothing to say. */
  problem(): string | null {
    const needs = `Soloist could not sign in to Spotify after ${this.max} tries — pair it again in Settings (soloist --pair); rune keeps trying every ${Math.round((this.opts.slowMs ?? 1_800_000) / 60_000)} minutes`;
    switch (this.state) {
      case 'waiting':
        return 'Soloist is signing in to Spotify — try again in a moment';
      case 'offline':
        return 'Soloist cannot reach Spotify (no network) — it signs in by itself when the network is back';
      case 'retrying':
        // The last restart did not help either.
        if (this.attempts >= this.max && this.signedOutSince !== null && this.now() - this.signedOutSince >= this.grace) return needs;
        return `Soloist is signing in to Spotify again (try ${this.attempts} of ${this.max}) — try again in a moment`;
      case 'needs-sign-in':
        return needs;
      default:
        return null;
    }
  }

  // ----- internals -----

  private evaluate(): void {
    if (this.closed) return;
    const v = this.opts.view();
    if (v.connected && v.loggedIn) {
      if (this.state !== 'ok') this.opts.log?.({ restarts: this.attempts }, 'soloist: signed in to Spotify');
      this.state = 'ok';
      this.attempts = 0;
      this.signedOutSince = null;
      this.disarm();
      return;
    }
    if (!v.connected) {
      // Not running or between two starts: the supervisor and the socket's own reconnect handle that. An armed timer
      // stays armed and looks again when it fires.
      this.signedOutSince = null;
      return;
    }
    if (this.signedOutSince === null) this.signedOutSince = this.now();
    if (this.state === 'ok') this.state = 'waiting';
    if (this.timer === null && !this.busy) this.arm(this.grace);
  }

  private arm(ms: number): void {
    this.disarm();
    this.timer = (this.opts.setTimeout ?? ((fn, m) => { const t = setTimeout(fn, m); t.unref?.(); return t; }))(() => {
      this.timer = null;
      void this.check();
    }, ms);
  }

  private disarm(): void {
    if (this.timer === null) return;
    (this.opts.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  /** The pause after the latest restart. */
  private pause(): number {
    if (this.attempts >= this.max) return this.opts.slowMs ?? 1_800_000;
    const list = this.opts.backoffMs ?? BACKOFF_MS;
    return Math.max(this.grace, list[Math.min(this.attempts - 1, list.length - 1)] ?? this.grace);
  }

  private async check(): Promise<void> {
    if (this.closed || this.busy) return;
    const v = this.opts.view();
    if (v.connected && v.loggedIn) return this.evaluate();
    // Between two starts, or signed out only for a moment (it may still be signing in): look again shortly.
    const since = this.signedOutSince;
    if (!v.connected || since === null) return this.arm(this.opts.offlinePollMs ?? 5000);
    const left = this.grace - (this.now() - since);
    if (left > 0) return this.arm(left);

    this.busy = true;
    let online = false;
    try { online = await this.opts.online(); } catch { /* not reachable */ }
    this.busy = false;
    if (this.closed) return;
    const after = this.opts.view();
    if (after.connected && after.loggedIn) return this.evaluate();
    if (!online) {
      if (this.state !== 'offline') this.opts.log?.({}, 'soloist: signed out and Spotify cannot be reached; waiting for the network');
      this.state = 'offline';
      return this.arm(this.opts.offlinePollMs ?? 5000);
    }
    if (!after.connected) return this.arm(this.opts.offlinePollMs ?? 5000);

    const slow = this.attempts >= this.max;
    if (!this.opts.restart('came up signed out of Spotify')) return this.arm(this.opts.offlinePollMs ?? 5000);
    if (!slow) this.attempts++;
    this.signedOutSince = null;
    const gaveUp = this.attempts >= this.max;
    this.opts.log?.(
      { attempt: this.attempts, of: this.max, nextCheckMs: this.pause() },
      slow
        ? 'soloist: still signed out of Spotify; restarted it (slow retry) — it may need pairing again (soloist --pair)'
        : gaveUp
          ? 'soloist: signed out of Spotify; restarted it a last time — if it stays signed out it needs pairing again (soloist --pair)'
          : 'soloist: signed out of Spotify; restarted it',
    );
    this.state = slow ? 'needs-sign-in' : 'retrying';
    this.arm(this.pause());
  }
}

let probing: Promise<boolean> | null = null;
/**
 * Does a Spotify host name resolve? The same resolver path Soloist uses (getaddrinfo), no request is sent to Spotify.
 * One lookup at a time (a hanging resolver must not pile up lookups) and at most `timeoutMs` long.
 */
export function spotifyReachable(timeoutMs = 3000, host = 'apresolve.spotify.com'): Promise<boolean> {
  if (!probing) {
    probing = lookup(host).then(() => true, () => false).finally(() => { probing = null; });
  }
  const current = probing;
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    t.unref?.();
    void current.then((ok) => { clearTimeout(t); resolve(ok); });
  });
}
