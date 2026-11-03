import { useEffect, useState } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { DITHER_PALETTES, paletteAt, paletteFromColour, type DitherHue, type DitherPalette, type Rgb } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';

/** The dot itself, then its trail: later, smaller, fainter. */
const TRAIL = [
  { lag: 0, size: 1, alpha: 1 },
  { lag: 45, size: 0.86, alpha: 0.42 },
  { lag: 90, size: 0.72, alpha: 0.24 },
  { lag: 135, size: 0.58, alpha: 0.12 },
];

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
 * The in-app mark: four dots on the corners of a square, in the backdrop's colour. One diagonal pair at a time floats
 * across to swap corners (bowing apart so they pass each other), then the other pair. Static with reduced motion.
 * (The old static mark is still at web/public/icons/mark.svg.)
 */
export function Logo({ size = 28 }: { size?: number }) {
  const pal = useBackdropPalette();
  // dot centres sit on a square 48% of the box wide; a pair travels the diagonal and bows 12% apart mid-way
  const diag = size * 0.48 * Math.SQRT2;
  const vars = {
    width: size,
    height: size,
    ['--dot-c' as string]: css(pal.light),
    ['--dot-d' as string]: `${size * 0.2}px`,
    ['--dot-L' as string]: `${diag}px`,
    ['--dot-o' as string]: `${size * 0.12}px`,
  };
  // each dot is followed by fading, shrinking copies running the same path a little later: its trail
  const dot = (n: 1 | 2) =>
    TRAIL.map((t, k) => (
      <b key={`${n}-${k}`} className={`dotlogo__x dotlogo__x--${n}${k ? ' dotlogo__ghost' : ''}`} style={{ ['--lag' as string]: `${t.lag}ms`, ['--gs' as string]: t.size, ['--ga' as string]: t.alpha }}>
        <i className={`dotlogo__y dotlogo__y--${n}`} />
      </b>
    )).reverse();
  const pair = (cls: string) => (
    <span className={`dotlogo__pair ${cls}`}>
      {dot(1)}
      {dot(2)}
    </span>
  );
  return (
    <span className="dotlogo" style={vars} aria-hidden>
      {pair('dotlogo__pair--a')}
      {pair('dotlogo__pair--b')}
    </span>
  );
}
