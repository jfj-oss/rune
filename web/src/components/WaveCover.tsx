import { useEffect, useRef } from 'react';
import { backdropShown } from '../lib/backdropShown';
import { DITHER_PALETTES } from '../lib/dither';
import { ditherLevels } from '../lib/dotLogo';
import { oppositePalette, waveField } from '../lib/waveCover';

const FRAME_MS = 1000 / 24;

/**
 * An animated cover: a thick wave filling ~80% of the square, dithered like the backdrop (blue-noise, light / mid
 * dots on black) in the colour opposite the one the backdrop is showing right now. Runs only while on screen and the
 * tab is visible; still with reduced motion.
 */
export function WaveCover({ seed = 0 }: { seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let w = 0, h = 0, img: ImageData | null = null, field = new Float32Array(0), levels = new Uint8Array(0);
    let raf = 0, last = 0, onScreen = true;
    const born = performance.now();
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const dot = Math.max(1, Math.floor(1.5 * dpr + 0.01)); // the backdrop's fine dot
      const r = canvas.getBoundingClientRect();
      const nw = Math.max(8, Math.round((r.width * dpr) / dot)), nh = Math.max(8, Math.round((r.height * dpr) / dot));
      if (nw === w && nh === h) return;
      w = nw; h = nh;
      canvas.width = w; canvas.height = h;
      img = ctx.createImageData(w, h);
      field = new Float32Array(w * h); levels = new Uint8Array(w * h);
    };
    const draw = (ms: number) => {
      if (!img) return;
      waveField(ms / 1000, w, h, field, seed);
      ditherLevels(field, w, h, levels, seed * 7, seed * 13);
      const { light, mid } = oppositePalette(backdropShown() ?? DITHER_PALETTES.red);
      const d = img.data;
      for (let i = 0; i < levels.length; i++) {
        const l = levels[i]!, o = i * 4, c = l === 2 ? light : l === 1 ? mid : null;
        d[o] = c ? c[0] : 0; d[o + 1] = c ? c[1] : 0; d[o + 2] = c ? c[2] : 0; d[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };
    const frame = (now: number) => {
      raf = 0;
      if (now - last >= FRAME_MS - 2) { last = now; draw(now - born); }
      if (!reduce.matches && onScreen && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (reduce.matches) { draw(0); return; }
      if (!raf && onScreen && document.visibilityState === 'visible') raf = requestAnimationFrame(frame);
    };
    const ro = new ResizeObserver(() => { fit(); draw(reduce.matches ? 0 : performance.now() - born); });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => { onScreen = !!e?.isIntersecting; start(); });
    io.observe(canvas);
    fit();
    start();
    document.addEventListener('visibilitychange', start);
    reduce.addEventListener('change', start);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', start);
      reduce.removeEventListener('change', start);
    };
  }, [seed]);
  return <canvas ref={ref} className="wavecover" aria-hidden />;
}
