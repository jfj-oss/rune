import { useEffect, useState } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { DITHER_PALETTES, paletteAt, paletteFromColour, type DitherHue, type DitherPalette, type Rgb } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';

const css = (c: Rgb) => `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])})`;

/** The palette the Dither backdrop is showing: its hue, the album page's colour, the playing album's, or the cycle. */
function useBackdropPalette(): DitherPalette {
  const ambient = useUi((s) => s.ambient);
  const page = useUi((s) => s.pagePalette);
  const album = usePlayer((s) => currentItem(s.state)?.album);
  const tint = useCoverColor(ambient === 'dither-album' ? album : undefined);
  const [t, setT] = useState(0);
  const cycling = ambient === 'dither-cycle' && !page;
  useEffect(() => {
    if (!cycling || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now() - (Number(new URLSearchParams(location.search).get('dither-t')) || 0) * 1000;
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') setT((performance.now() - start) / 1000); }, 500);
    return () => clearInterval(id);
  }, [cycling]);
  if (ambient === 'off') return DITHER_PALETTES.red;
  if (page) return page;
  if (ambient === 'dither-album') return (album && paletteFromColour(tint)) || DITHER_PALETTES.purple;
  if (cycling) return paletteAt('cycle', t);
  const hue = (ambient === 'dither' ? 'red' : ambient.slice(7)) as DitherHue;
  return DITHER_PALETTES[hue] ?? DITHER_PALETTES.red;
}

/**
 * The in-app mark: three dots in the backdrop's colour that pop up one after another and fade, like a "working"
 * indicator. Static with reduced motion. (The old static mark is still at web/public/icons/mark.svg.)
 */
export function Logo({ size = 28 }: { size?: number }) {
  const pal = useBackdropPalette();
  return (
    <span className="dotlogo" style={{ width: size, height: size, ['--dot-c' as string]: css(pal.light), ['--dot-m' as string]: css(pal.mid) }} aria-hidden>
      <i /><i /><i />
    </span>
  );
}
