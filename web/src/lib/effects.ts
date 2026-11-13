// "Reduce effects" (Settings → Background): no glass blur behind panels and no decorative animation. A GPU saver for
// big screens. Per device, like the keyboard keys: it is about this machine's graphics, not the user's taste.
//
// The setting is a `data-effects="reduced"` attribute on <html>: the CSS swaps every backdrop-filter for a solid,
// slightly translucent panel there, and the animated canvases (AsciiWaves, WaveCover, Logo, the Dither backdrop) treat
// it exactly like prefers-reduced-motion through `stillQuery()`.

import { useSyncExternalStore } from 'react';

export const EFFECTS_KEY = 'rune.reduceEffects';
const EVENT = 'rune:effects';

export function loadReduceEffects(): boolean {
  try { return localStorage.getItem(EFFECTS_KEY) === '1'; } catch { return false; }
}

export function saveReduceEffects(on: boolean): void {
  try {
    if (on) localStorage.setItem(EFFECTS_KEY, '1');
    else localStorage.removeItem(EFFECTS_KEY);
  } catch { /* storage blocked */ }
}

/** Is the setting on in this page (the attribute on <html>)? */
export function effectsReduced(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.effects === 'reduced';
}

/** Put the setting on the page and tell the animated parts. */
export function applyReduceEffects(on: boolean): void {
  if (typeof document === 'undefined') return; // node (unit tests): nothing to paint
  const root = document.documentElement;
  if (on === effectsReduced()) return;
  if (on) root.dataset.effects = 'reduced';
  else delete root.dataset.effects;
  window.dispatchEvent(new Event(EVENT));
}

/** What the animated parts listen to: the system's reduced motion, or this setting. */
export interface StillQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', fn: () => void): void;
  removeEventListener(type: 'change', fn: () => void): void;
}

/** A drop-in for `matchMedia('(prefers-reduced-motion: reduce)')` that is also true while effects are reduced. */
export function stillQuery(): StillQuery {
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  return {
    get matches() { return effectsReduced() || !!media?.matches; },
    addEventListener(_type, fn) {
      media?.addEventListener('change', fn);
      window.addEventListener(EVENT, fn);
    },
    removeEventListener(_type, fn) {
      media?.removeEventListener('change', fn);
      window.removeEventListener(EVENT, fn);
    },
  };
}

/** React: true while things stand still (system reduced motion, or this setting); re-renders when that changes. */
export function useStill(): boolean {
  return useSyncExternalStore(
    (fn) => { const q = stillQuery(); q.addEventListener('change', fn); return () => q.removeEventListener('change', fn); },
    () => stillQuery().matches,
    () => false,
  );
}

// "Battery saver" (Settings → Background): the animated canvases also hold still while another window has focus, not
// only while the tab is hidden. Per device too: on a laptop it saves power, on a desktop with rune on a second screen
// you may want it moving. A `data-saver="on"` attribute on <html>; the same event tells the animated parts.
export const SAVER_KEY = 'rune.batterySaver';

export function loadBatterySaver(): boolean {
  try { return localStorage.getItem(SAVER_KEY) === '1'; } catch { return false; }
}

export function saveBatterySaver(on: boolean): void {
  try {
    if (on) localStorage.setItem(SAVER_KEY, '1');
    else localStorage.removeItem(SAVER_KEY);
  } catch { /* storage blocked */ }
}

export function batterySaverOn(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.saver === 'on';
}

export function applyBatterySaver(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (on === batterySaverOn()) return;
  if (on) document.documentElement.dataset.saver = 'on';
  else delete document.documentElement.dataset.saver;
  window.dispatchEvent(new Event(EVENT));
}

/** Should the animated canvases run: the tab is shown and, with Battery saver on, its window has focus. */
export function looking(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  return !batterySaverOn() || document.hasFocus();
}

/** Calls `fn` whenever `looking()` may have changed (tab shown/hidden, focus, Battery saver). Returns the unsubscribe. */
export function onLooking(fn: () => void): () => void {
  document.addEventListener('visibilitychange', fn);
  window.addEventListener('focus', fn);
  window.addEventListener('blur', fn);
  window.addEventListener(EVENT, fn);
  return () => {
    document.removeEventListener('visibilitychange', fn);
    window.removeEventListener('focus', fn);
    window.removeEventListener('blur', fn);
    window.removeEventListener(EVENT, fn);
  };
}
