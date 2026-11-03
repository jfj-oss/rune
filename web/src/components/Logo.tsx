import { useEffect, useState } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { DITHER_PALETTES, paletteAt, paletteFromColour, type DitherHue, type DitherPalette, type Rgb } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';

/** The dot itself, then its trail: tiny square "dither" pixels running the same path a little later, scattered
    around it (jx/jy in px, along/across the path), fainter the further back, alternating the light and mid tone. */
const TRAIL = [
  { lag: 0, alpha: 1, jx: 0.0, jy: 0.0, mid: false },
  { lag: 28, alpha: 0.85, jx: -0.76, jy: -2.09, mid: false },
  { lag: 50, alpha: 0.7, jx: 1.14, jy: 1.71, mid: true },
  { lag: 74, alpha: 0.6, jx: -1.52, jy: 0.38, mid: false },
  { lag: 98, alpha: 0.48, jx: 0.57, jy: -2.66, mid: true },
  { lag: 124, alpha: 0.38, jx: -0.38, jy: 2.47, mid: false },
  { lag: 150, alpha: 0.28, jx: 1.33, jy: -0.76, mid: true },
  { lag: 178, alpha: 0.2, jx: -1.14, jy: 1.52, mid: false },
  { lag: 206, alpha: 0.12, jx: 0.38, jy: -1.71, mid: true },
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
  // dot centres sit on a square 36% of the box wide; a pair travels the diagonal and bows apart mid-way
  const diag = size * 0.36 * Math.SQRT2;
  const vars = {
    width: size,
    height: size,
    ['--dot-c' as string]: css(pal.light),
    ['--dot-m' as string]: css(pal.mid),
    ['--dot-d' as string]: `${size * 0.11}px`,
    ['--dot-px' as string]: `${Math.max(1, size * 0.05)}px`,
    ['--dot-L' as string]: `${diag}px`,
    ['--dot-o' as string]: `${size * 0.095}px`,
  };
  // each dot is followed by fading, shrinking copies running the same path a little later: its trail
  const dot = (n: 1 | 2) =>
    TRAIL.map((t, k) => (
      <b key={`${n}-${k}`} className={`dotlogo__x dotlogo__x--${n}${k ? ` dotlogo__ghost${t.mid ? ' dotlogo__ghost--mid' : ''}` : ''}`} style={{ ['--lag' as string]: `${t.lag}ms`, ['--ga' as string]: t.alpha, ['--jx' as string]: `${t.jx}px`, ['--jy' as string]: `${n === 1 ? t.jy : -t.jy}px` }}>
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
