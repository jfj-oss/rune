/**
 * The browser zone lives in each tab: two tabs of the same browser would both play (B2). A tab whose browser zone
 * starts to sound says so on a BroadcastChannel, and the other tabs of that browser pause theirs. Other browsers and
 * devices are not reached this way (that is the server-held queue's job).
 */
export interface TabChannel {
  /** This tab's browser zone just started to sound. */
  started(): void;
  /** Another tab's browser zone started: `fn` should pause this one. */
  onOtherStarted(fn: () => void): void;
  close(): void;
}

const CHANNEL = 'rune-browser-zone';

/** null where BroadcastChannel does not exist (very old Safari): tabs then behave as before. */
export function createTabChannel(name = CHANNEL): TabChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const ch = new BroadcastChannel(name);
  const me = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let handler: () => void = () => {};
  /** When this tab last started: a message about an older start (two tabs pressing Play at once) is no reason to stop. */
  let mine = Number.NEGATIVE_INFINITY;
  ch.onmessage = (e: MessageEvent) => {
    const m = e.data as { type?: unknown; from?: unknown; at?: unknown } | null;
    if (m?.type !== 'started' || m.from === me || typeof m.at !== 'number' || typeof m.from !== 'string') return;
    // The newer start wins; a tie goes to the larger id, so exactly one of two tabs keeps playing.
    if (m.at > mine || (m.at === mine && m.from > me)) handler();
  };
  return {
    started() {
      mine = Date.now();
      try {
        ch.postMessage({ type: 'started', from: me, at: mine });
      } catch {
        /* closed */
      }
    },
    onOtherStarted(fn) {
      handler = fn;
    },
    close() {
      handler = () => {};
      ch.close();
    },
  };
}
