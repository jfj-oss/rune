import { useEffect, useRef, useState } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { DITHER_PALETTES, paletteAt, paletteFromColour, type DitherHue, type DitherPalette } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { brightness, ditherLevels } from '../lib/dotLogo';
import { backdropShown, onBackdrop } from '../lib/backdropShown';


const BLACK = [0, 0, 0] as const;

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
 * The in-app mark: four balls on a square; one diagonal pair at a time swaps corners with a trail behind it. The whole
 * picture is drawn as a soft brightness field and dithered like the backdrop (blue-noise thresholds and light / mid
 * shares) at one dot per CSS pixel, a little finer than the backdrop's. Still with reduced motion; paused when hidden.
 * (The old static mark is still at web/public/icons/mark.svg.)
 */
export function Logo({ size = 28 }: { size?: number }) {
  const pal = useBackdropPalette();
  const palRef = useRef(pal);
  palRef.current = pal;
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    // the backdrop's dithering at one dot per CSS pixel (2 device pixels on a Retina screen): between the finest grain
    // and the backdrop's own ~1.5 px
    const dpr = window.devicePixelRatio || 1;
    const dot = Math.max(1, Math.round(dpr));
    const w = Math.max(8, Math.round((size * dpr) / dot));
    canvas.width = canvas.height = w;
    canvas.style.width = canvas.style.height = `${(w * dot) / dpr}px`;
    const img = ctx.createImageData(w, w);
    const field = new Float32Array(w * w), levels = new Uint8Array(w * w);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const born = performance.now();
    let raf = 0;
    const draw = (ms: number) => {
      brightness(ms, w, w, field);
      ditherLevels(field, w, w, levels);
      // the backdrop's own colour on this very frame when it is showing (so the cycle and blends match exactly)
      const { mid, light } = backdropShown() ?? palRef.current;
      const d = img.data;
      for (let i = 0; i < levels.length; i++) {
        const l = levels[i]!, o = i * 4;
        // inside a ball or its trail the gaps between dots are black, like the backdrop; outside, see-through
        const c = l === 2 ? light : l === 1 ? mid : BLACK;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = l || field[i]! > 0.015 ? 255 : 0;
      }
      ctx.putImageData(img, 0, 0);
    };
    const frame = (now: number) => {
      raf = 0;
      draw(now - born);
      if (!reduce.matches && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (reduce.matches) { draw(0); return; }
      if (!raf && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    redraw.current = () => { if (!raf) draw(reduce.matches ? 0 : performance.now() - born); };
    start();
    // when still (reduced motion), repaint as the backdrop's colour changes
    const offBackdrop = onBackdrop(() => redraw.current());
    document.addEventListener('visibilitychange', start);
    reduce.addEventListener('change', start);
    return () => {
      cancelAnimationFrame(raf);
      offBackdrop();
      document.removeEventListener('visibilitychange', start);
      reduce.removeEventListener('change', start);
      redraw.current = () => {};
    };
  }, [size]);

  // a new colour shows at once even when the animation is still (reduced motion)
  useEffect(() => { redraw.current(); }, [pal]);

  return <canvas ref={ref} className="dotlogo" width={1} height={1} style={{ width: size, height: size }} aria-hidden />;
}
