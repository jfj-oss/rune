import { useEffect, useRef } from 'react';
import { backdropShown } from '../lib/backdropShown';
import { blueNoise, DITHER_PALETTES, type Rgb } from '../lib/dither';
import { ASCII_CHARS, asciiAt, oppositePalette, type GenKind } from '../lib/waveCover';

const CELL_W = 6, CELL_H = 8; // CSS px per character
const FRAME_MS = 1000 / 20;
const DENSITY = 0.34; // at most about a third of the cells on a wave crest hold a character: very sparse
const N = 64;
let rank: Uint16Array | null = null;

const css = (c: Rgb, a = 1) => `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${a})`;

/**
 * The header behind a wave playlist: very sparse, very fine "x" and "o" characters riding slow waves, dithered with
 * the backdrop's blue noise, in the colour opposite the backdrop's (like the cover). On screen + visible tab only.
 */
export function AsciiWaves({ kind = 'wave' }: { kind?: GenKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    rank ??= blueNoise(N);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let cols = 0, rows = 0, dpr = 1, raf = 0, last = 0, onScreen = true;
    const born = performance.now();
    const fit = () => {
      dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      cols = Math.ceil(r.width / CELL_W); rows = Math.ceil(r.height / CELL_H);
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    };
    const draw = (ms: number) => {
      const t = ms / 1000;
      const { light, mid } = oppositePalette(backdropShown() ?? DITHER_PALETTES.red);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cols * CELL_W, rows * CELL_H);
      ctx.font = `600 ${CELL_H}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = 'top';
      const o = css(light), x = css(mid, 0.95);
      const chars = ASCII_CHARS[kind];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const f = asciiAt(kind, (c + 0.5) / cols, (r + 0.5) / rows, t);
          if (f < 0.08) continue;
          const th = (rank![(r % N) * N + (c % N)]! + 0.5) / (N * N);
          if (th >= f * DENSITY) continue;
          const crest = f > 0.62;
          ctx.fillStyle = crest ? o : x;
          ctx.fillText(crest ? chars[1] : chars[0], c * CELL_W, r * CELL_H);
        }
      }
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
  }, [kind]);
  return <canvas ref={ref} className="asciiwaves" aria-hidden />;
}
