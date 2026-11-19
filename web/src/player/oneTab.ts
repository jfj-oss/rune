/**
 * Tabs of one browser share one browser zone (one queue on the server), and only one of them may sound it. The tab
 * that starts to sound claims it on a BroadcastChannel, and the other tabs let go. A tab that opens while the zone is
 * playing asks first whether some tab already sounds it, and only takes over when nobody answers. Other browsers and
 * devices have zones of their own (browser:<their id>), so they are not reached this way.
 */
export interface TabChannel {
  /** This tab sounds the zone now. */
  claimed(): void;
  /** Another tab claimed the zone: `fn` should let go of it. */
  onClaimedElsewhere(fn: () => void): void;
  /** Does any other tab sound the zone? (Resolves false after `timeoutMs` without an answer.) */
  anyoneSounding(timeoutMs?: number): Promise<boolean>;
  /** Answer other tabs' question: is this tab sounding the zone? */
  onAsked(fn: () => boolean): void;
  close(): void;
}

const CHANNEL = 'rune-browser-zone';

/** null where BroadcastChannel does not exist (very old Safari): a tab then sounds only what it started itself. */
export function createTabChannel(name = CHANNEL): TabChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(name);
  const me = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let letGo: () => void = () => {};
  let sounding: () => boolean = () => false;
  const waiting = new Set<() => void>();
  /** When this tab last claimed: a message about an older claim (two tabs pressing Play at once) is no reason to let go. */
  let mine = Number.NEGATIVE_INFINITY;
  const post = (m: object) => { try { ch.postMessage({ ...m, from: me }); } catch { /* closed */ } };
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: unknown; from?: unknown; at?: unknown } | null;
    if (!m || m.from === me || typeof m.from !== 'string') return;
    if (m.type === 'claimed' && typeof m.at === 'number') {
      // The newer claim wins; a tie goes to the larger id, so exactly one of two tabs keeps the zone.
      if (m.at > mine || (m.at === mine && m.from > me)) letGo();
    } else if (m.type === 'asked') {
      if (sounding()) post({ type: 'sounding' });
    } else if (m.type === 'sounding') {
      for (const f of [...waiting]) f();
    }
  };
  return {
    claimed() {
      mine = Date.now();
      post({ type: 'claimed', at: mine });
    },
    onClaimedElsewhere(fn) { letGo = fn; },
    anyoneSounding(timeoutMs = 400) {
      return new Promise<boolean>((resolve) => {
        const done = (v: boolean) => { clearTimeout(t); waiting.delete(yes); resolve(v); };
        const yes = () => done(true);
        const t = setTimeout(() => done(false), timeoutMs);
        waiting.add(yes);
        post({ type: 'asked' });
      });
    },
    onAsked(fn) { sounding = fn; },
    close() {
      letGo = () => {};
      sounding = () => false;
      ch.close();
    },
  };
}
