import { dominantColour } from './color';

/* Cover glow: on hover-capable pointers, an album / playlist card lifts and glows in its own cover's colour.
   One delegated listener; the colour is sampled lazily (24x24, once per image) from the cover that is already loaded,
   then handed to CSS as `--glow` on the card art, so there is no extra request, no per-card work until hovered and
   no extra layers. Covers that cannot be read (cross-origin Spotify images) simply get the neutral lift. */
const cache = new Map<string, string>();

export function installCoverGlow(): void {
  if (typeof window === 'undefined' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.addEventListener('pointerover', (e) => {
    const art = (e.target as Element | null)?.closest?.('.card__art') as HTMLElement | null;
    if (!art || art.dataset.glow) return;
    const img = art.querySelector('img');
    if (!img || !img.complete || img.naturalWidth === 0) return; // not loaded yet: try again on the next hover
    art.dataset.glow = '1';
    const key = img.currentSrc || img.src;
    let c = cache.get(key);
    if (!c) {
      try { c = dominantColour(img) ?? undefined; } catch { /* tainted canvas */ }
      if (c) cache.set(key, c);
    }
    if (c) art.style.setProperty('--glow', c.replace(')', ' / 0.6)'));
  }, { passive: true });
}
