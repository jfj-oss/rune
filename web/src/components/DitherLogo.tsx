import { useEffect, useRef, useState } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { mixPalette, paletteAt, paletteFromColour, type DitherColour, type DitherPalette } from '../lib/dither';
import { crispFor, ditherGrid, logoDot, logoGrid, paintGrid, resampleTones, type ToneMap } from '../lib/ditherLogo';
import { currentItem, usePlayer } from '../store/player';
import { useUi, type Ambient } from '../store/ui';

/* The rune mark: a ladybird cut-out (public/icons/ladybug-tones.png, see scripts/ladybug-logo.py) ordered-dithered
   into black + mid + light, in exactly the palette of the Dither backdrop: the chosen hue, the cycling blend, the
   album page's colour, or the playing album's colour in "Dither · Album". With the backdrop off it is the red
   palette (the default Dither colour). */

const SRC = '/icons/ladybug-tones.png';
/** Layout height / width of the artwork (the PNG is 128 x 106). */
const ASPECT = 106 / 128;

let toneMap: Promise<ToneMap | null> | null = null;
function loadTones(): Promise<ToneMap | null> {
  toneMap ??= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const n = c.width * c.height;
        const tone = new Uint8Array(n), mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) { tone[i] = px[i * 4]!; mask[i] = px[i * 4 + 3]!; }
        resolve({ w: c.width, h: c.height, tone, mask });
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = SRC;
  });
  return toneMap;
}

/** What the backdrop would be showing, as a palette source. */
type LogoColour = DitherColour | DitherPalette;
const resolve = (c: LogoColour, t: number): DitherPalette => (typeof c === 'string' ? paletteAt(c, t) : c);
const hueOf = (a: Ambient): DitherColour => (a === 'dither' || a === 'off' || a === 'dither-album' ? 'red' : (a.slice(7) as DitherColour));
const BLEND_S = 1.4; // same glide as the backdrop when the album colour changes

function LogoCanvas({ size, colour }: { size: number; colour: LogoColour }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colourRef = useRef(colour);
  colourRef.current = colour;
  const kick = useRef<() => void>(() => {});
  const [map, setMap] = useState<ToneMap | null>(null);
  useEffect(() => { let dead = false; void loadTones().then((m) => { if (!dead) setMap(m); }); return () => { dead = true; }; }, []);

  const aspect = map ? map.h / map.w : ASPECT;
  const cssH = Math.round(size * aspect);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !map) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    // like the backdrop, `?dither-t=40` starts the cycle 40 s in; the clock stands still while the tab is hidden
    let t0 = performance.now() - (Number(new URLSearchParams(location.search).get('dither-t')) || 0) * 1000;
    let hiddenAt = 0;
    const clock = () => (performance.now() - t0) / 1000;
    let grid: Uint8Array | null = null, gw = 0, gh = 0, img: ImageData | null = null;
    let shown: DitherPalette | null = null, drawn: DitherPalette | null = null;
    let last = performance.now(), timer = 0;

    const build = () => {
      const dpr = window.devicePixelRatio || 1;
      const dot = logoDot(dpr);
      const g = logoGrid(size, map.h / map.w, dpr, dot);
      gw = g.w; gh = g.h;
      const r = resampleTones(map, gw, gh);
      grid = ditherGrid(r.tone, r.cover, gw, gh, true, crispFor(gw));
      canvas.width = gw; canvas.height = gh;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${Math.round(size * map.h / map.w)}px`;
      img = ctx.createImageData(gw, gh);
      drawn = null;
    };
    const differs = (a: DitherPalette, b: DitherPalette | null) =>
      !b || a.mid.some((v, i) => Math.abs(v - b.mid[i]!) > 0.6) || a.light.some((v, i) => Math.abs(v - b.light[i]!) > 0.6);
    const tick = () => {
      timer = 0;
      const still = reduce.matches;
      const want = resolve(colourRef.current, still ? 0 : clock());
      const now = performance.now();
      const k = shown && !still ? 1 - Math.exp(-((now - last) / 1000) / (BLEND_S / 3)) : 1;
      last = now;
      shown = shown ? mixPalette(shown, want, k) : want;
      if (!grid || !img) build();
      if (differs(shown, drawn)) {
        paintGrid(grid!, shown, img!.data);
        ctx.putImageData(img!, 0, 0);
        drawn = shown;
      }
      // keep ticking (a few times a second) only while the colour is moving: the cycle, or an album blend
      const moving = !still && document.visibilityState === 'visible' && (colourRef.current === 'cycle' || differs(want, shown));
      if (moving) timer = window.setTimeout(tick, colourRef.current === 'cycle' && !differs(want, shown) ? 250 : 80);
    };
    kick.current = () => { if (!timer) tick(); };
    const onVis = () => {
      if (document.visibilityState === 'visible') { if (hiddenAt) t0 += performance.now() - hiddenAt; hiddenAt = 0; last = performance.now(); kick.current(); }
      else { hiddenAt = performance.now(); clearTimeout(timer); timer = 0; }
    };
    const onResize = () => { grid = null; kick.current(); };
    const onMotion = () => { clearTimeout(timer); timer = 0; kick.current(); };
    build();
    tick();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('resize', onResize);
    reduce.addEventListener('change', onMotion);
    return () => {
      clearTimeout(timer);
      kick.current = () => {};
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('resize', onResize);
      reduce.removeEventListener('change', onMotion);
    };
  }, [map, size]);

  useEffect(() => { kick.current(); }, [colour]);

  return <canvas ref={ref} width={1} height={1} style={{ width: size, height: cssH, imageRendering: 'pixelated', display: 'block', flex: 'none' }} aria-hidden="true" />;
}

/** "Dither · Album": the playing album's cover colour (purple when nothing plays), like the backdrop. */
function AlbumLogo({ size }: { size: number }) {
  const album = usePlayer((s) => currentItem(s.state)?.album);
  const tint = useCoverColor(album);
  const page = useUi((s) => s.pagePalette);
  return <LogoCanvas size={size} colour={page ?? (album && paletteFromColour(tint)) ?? 'purple'} />;
}

export function DitherLogo({ size = 28 }: { size?: number }) {
  const ambient = useUi((s) => s.ambient);
  const page = useUi((s) => s.pagePalette);
  if (ambient === 'dither-album') return <AlbumLogo size={size} />;
  // an open album page tints every Dither mode with its own cover colour; with the backdrop off there is none
  return <LogoCanvas size={size} colour={ambient !== 'off' && page ? page : hueOf(ambient)} />;
}
