/* The palette the page's main Dither backdrop is painting right now (after its colour cycle and blends), so the
   logo can show exactly the same colour on the same frame instead of keeping a clock of its own. */
import type { DitherPalette } from './dither';

let shown: DitherPalette | null = null;
const subs = new Set<() => void>();

/** Called by the main backdrop on every paint; null when it goes away. */
export function publishBackdrop(p: DitherPalette | null): void {
  shown = p;
  for (const f of subs) f();
}

/** The backdrop's current palette, or null when no backdrop is showing. */
export const backdropShown = (): DitherPalette | null => shown;

export function onBackdrop(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}
