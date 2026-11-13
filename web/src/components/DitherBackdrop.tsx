import { useEffect, useRef, useState } from 'react';
import { publishBackdrop } from '../lib/backdropShown';
import {
  blueNoise, calmFor, densities, dotSize, ditherLevel, field, MASK, MOTTLE, mottle, mixPalette, paletteAt, POOLS, radiusScale, RIBBONS, TONE, toneCurve, WARP,
  WAVE, waveAt, wavePeakExponent, mixAt, modulatorsAt, currentAt, type DitherColour, type DitherPalette,
} from '../lib/dither';
import { backdropFrameMs } from '../lib/frameRate';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';

/* "Dither" ambient: slow drifting abstract light forms, ordered-dithered (blue-noise thresholds) into black + a dark
   mid tone + one strong colour. Drawn by a WebGL1 fragment shader into a low-res canvas (~2 CSS px per dot) that is
   upscaled with `image-rendering: pixelated`; ~30 fps cap, paused while hidden, one static frame under
   prefers-reduced-motion. Falls back to a static Canvas 2D frame without WebGL. */

const NOISE_N = 64;
let noiseTile: Uint8Array | null = null;
function noise(): Uint8Array {
  if (!noiseTile) {
    const rank = blueNoise(NOISE_N);
    noiseTile = new Uint8Array(rank.length);
    // store (rank + 0.5) / N in a byte; the shader reads it back as a threshold in (0, 1)
    for (let i = 0; i < rank.length; i++) noiseTile[i] = Math.min(255, Math.floor(((rank[i]! + 0.5) / rank.length) * 256));
  }
  return noiseTile;
}

const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

/** Shape numbers of the non-drift characters (shader constants; tuned for similar coverage to drift). */
const TIDE = { k1: 13, k2: 8.5, gain: 1.2, lo: 0.36, hi: 0.96 };
const RIPPLE = { k: 21, norm: 1.0, gain: 1.15, lo: 0.1, hi: 0.8 };
const AURORA = { k1: 11, k2: 17, gain: 1.3, lo: 0.2, hi: 0.72, floor: 0.15 };

const g = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const poolGlsl = POOLS.map((b) =>
  `f += ${g(b.w)} * pool(w, vec2(${g(b.bx)} * u_aspect + ${g(b.ax)} * u_aspect * sin(t * ${g(b.wx)} + ${g(b.px)}), ` +
  `${g(b.by)} + ${g(b.ay)} * cos(t * ${g(b.wy)} + ${g(b.py)})), ${g(b.r)});`,
).join('\n  ');
const ribbonGlsl = RIBBONS.map((r) =>
  `d = w.y - (${g(r.y0)} + ${g(r.slope)} * xn + ${g(r.a1)} * sin(xn * ${g(r.f1)} + t * ${g(r.s1)}) + ${g(r.a2)} * sin(xn * ${g(r.f2)} - t * ${g(r.s2)}));\n` +
  `  f += ${g(r.w)} * exp(-(d * d) / (${g(r.w2)} * u_rs * u_rs)) * smoothstep(${g(r.fadeFrom)}, ${g(r.fadeFrom + 0.5)}, xn);`,
).join('\n  ');

/* Generated from the same constants as field() / toneCurve() / densities() / ditherLevel() in lib/dither.ts. */
const FRAG = `precision highp float;
uniform vec2 u_res;
uniform float u_aspect;
uniform float u_rs;     // radiusScale(aspect)
uniform float u_t;
uniform vec3 u_mid;
uniform vec3 u_light;
uniform float u_wave;   // new-song wave: how far the shapes have swelled out, 0..1 (waveAt)
uniform float u_calm;   // share of dots kept (the phone's fine grain is sparser)
uniform float u_wexp;   // field exponent at the wave's peak (wavePeakExponent)
uniform sampler2D u_noise;
uniform vec4 u_mix;     // weights of the field characters: drift, tide, ripple, aurora (sum 1; see mixAt)
uniform vec3 u_mod;     // flow angle, zoom, warped clock (modulatorsAt)
uniform vec4 u_cur;     // travelling current: direction xy, position, strength (currentAt)

float hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x), mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
float pool(vec2 p, vec2 c, float r) { vec2 d = p - c; r *= u_rs; return exp(-dot(d, d) / (r * r)); }

void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_res.x, 1.0 - gl_FragCoord.y / u_res.y);
  vec2 q = vec2(uv.x * u_aspect, uv.y);
  float t = u_t;
  vec2 w = q + ${g(WARP.amp)} * (vec2(
    vnoise(vec2(q.x * ${g(WARP.freq)} + t * ${g(WARP.speed)}, q.y * ${g(WARP.freq)})),
    vnoise(vec2(q.x * ${g(WARP.freq)} + 7.1, q.y * ${g(WARP.freq)} - t * ${g(WARP.speed * 0.8)}))) - 0.5);
  float fdr = 0.0, f2 = 0.0; // weighted sum of squares: an energy-preserving crossfade (coverage does not dip midway)
  if (u_mix.x > 0.0) {
    float f = 0.0;
  ${poolGlsl}
    float xn = w.x / u_aspect;
    float d;
    ${ribbonGlsl}
    fdr = f;
    f2 += u_mix.x * f * f;
  }
  if (u_mix.x < 1.0) {
    // the other characters share a rotated, zoomed frame around the screen centre, a stronger version of the
    // same slow warp, and one travelling current
    float tt = u_mod.z;
    vec2 c = vec2(0.5 * u_aspect, 0.5);
    float ca = cos(u_mod.x), sa = sin(u_mod.x);
    vec2 r0 = (q + 2.2 * (w - q) - c) / (u_rs * u_mod.y);
    vec2 p = vec2(ca * r0.x - sa * r0.y, sa * r0.x + ca * r0.y);
    float cd = dot(q - c, u_cur.xy) - u_cur.z;
    float cur = u_cur.w * exp(-cd * cd / 0.03);
    if (u_mix.y > 0.0) { // tide: two layers of broad horizontal swells, warped by a little noise
      float s1 = 0.5 + 0.5 * sin(p.y * ${g(TIDE.k1)} + tt * 0.11 + 1.1 * sin(p.x * 1.3 + tt * 0.04) + 2.0 * vnoise(vec2(p.x * 0.9, tt * 0.02)));
      float s2 = 0.5 + 0.5 * sin(p.y * ${g(TIDE.k2)} - tt * 0.07 + 0.9 * sin(p.x * 0.8 - tt * 0.03 + 2.0));
      float ft = ${g(TIDE.gain)} * smoothstep(${g(TIDE.lo)}, ${g(TIDE.hi)}, 0.6 * s1 + 0.4 * s2) + cur;
      f2 += u_mix.y * ft * ft;
    }
    if (u_mix.z > 0.0) { // ripple: rings from two slowly wandering centres, fading with distance, interfering
      vec2 c1 = vec2(0.15 * sin(tt * 0.013), 0.1 + 0.12 * cos(tt * 0.017));
      vec2 c2 = vec2(0.55 * sin(tt * 0.011 + 2.0) - 0.2, 0.2 * cos(tt * 0.014 + 1.0));
      float r1 = length(p - c1), r2 = length(p - c2);
      float a1 = smoothstep(0.4, 1.0, 0.5 + 0.5 * sin(r1 * ${g(RIPPLE.k)} - tt * 0.42));
      float a2 = smoothstep(0.4, 1.0, 0.5 + 0.5 * sin(r2 * ${g(RIPPLE.k * 0.8)} - tt * 0.34 + 1.7));
      float v = (a1 * exp(-r1 * r1 * 1.6) + 0.8 * a2 * exp(-r2 * r2 * 2.4)) * ${g(RIPPLE.norm)};
      float fr = ${g(RIPPLE.gain)} * smoothstep(${g(RIPPLE.lo)}, ${g(RIPPLE.hi)}, v) + cur;
      f2 += u_mix.z * fr * fr;
    }
    if (u_mix.w > 0.0) { // aurora: tall curtains that sway, brighter near the top
      float sway = 0.7 * sin(p.y * 2.1 + tt * 0.06) + 0.35 * sin(p.y * 4.3 - tt * 0.05 + 1.0) + 1.2 * vnoise(vec2(p.x * 0.7, p.y * 0.8 + tt * 0.015));
      float c1 = 0.5 + 0.5 * sin(p.x * ${g(AURORA.k1)} + sway + tt * 0.045);
      float c2 = 0.5 + 0.5 * sin(p.x * ${g(AURORA.k2)} - sway * 0.7 - tt * 0.035 + 2.0);
      float shimmer = 0.82 + 0.18 * vnoise(vec2(p.x * 9.0, p.y * 1.4 - tt * 0.07));
      float top = ${g(AURORA.floor)} + (1.0 - ${g(AURORA.floor)}) * (1.0 - smoothstep(-0.55, 0.65, p.y));
      float fa = ${g(AURORA.gain)} * smoothstep(${g(AURORA.lo)}, ${g(AURORA.hi)}, 0.6 * c1 + 0.4 * c2) * shimmer * top + cur;
      f2 += u_mix.w * fa * fa;
    }
  }
  float f = u_mix.x >= 1.0 ? fdr : sqrt(f2); // pure drift stays bit-identical to the original field
  // new-song wave: the shapes already on screen swell outwards (lifting the field fills their faint edges
  // first) and draw back in. A gentle ripple rides the growing edge; its phase follows the swell itself
  // (out while growing, back while shrinking), so it never jumps or flickers.
  if (u_wave != 0.0) { // below 0 (the bounce after the crash) the shapes shrink a little below rest
    // e = peak^amt: the covered area grows evenly with the swell
    float grown = pow(max(f, 0.0), pow(u_wexp, u_wave));
    float edge = smoothstep(0.05, 0.3, grown) * (1.0 - smoothstep(0.6, 0.95, grown));
    f = grown + u_wave * ${g(WAVE.ripple)} * edge * sin(grown * 9.0 - u_wave * 6.0);
  }
  float mot = ${g(MOTTLE.base)} + ${g(MOTTLE.amp)} * vnoise(vec2(q.x * ${g(MOTTLE.freq)} + t * ${g(MOTTLE.speed)}, q.y * ${g(MOTTLE.freq)}));

  float tau = pow(smoothstep(${g(TONE.lo)}, ${g(TONE.hi)}, f), ${g(TONE.gamma)});
  float dL = pow(tau, 1.6) * ${g(MASK.light)} * min(1.0, mot) * u_calm;
  float dM = min(1.0 - dL, pow(tau, 0.6) * ${g(MASK.mid)} * u_calm);

  // byte b encodes the threshold (b + 0.5) / 256, never 0 or 1, so pure black / pure light stay clean
  float th = (texture2D(u_noise, (floor(mod(gl_FragCoord.xy, ${NOISE_N}.0)) + 0.5) / ${NOISE_N}.0).r * 255.0 + 0.5) / 256.0;
  float lvl = th < dL ? 2.0 : (th < dL + dM ? 1.0 : 0.0);
  vec3 col = lvl < 0.5 ? vec3(0.0) : (lvl < 1.5 ? u_mid : u_light);
  gl_FragColor = vec4(col / 255.0, 1.0);
}`;

interface Wave { amt: number; dir: number; t: number }
const NO_WAVE: Wave = { amt: 0, dir: 1, t: 0 };
interface Renderer { draw(t: number, pal: DitherPalette, wave?: Wave): void; resize(w: number, h: number, calm?: number): void; dispose(): void }

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  return s;
}

function webglRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) return null;
  try {
    const prog = gl.createProgram()!;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, NOISE_N, NOISE_N, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, noise());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const u = (n: string) => gl.getUniformLocation(prog, n);
    const uRes = u('u_res'), uAspect = u('u_aspect'), uT = u('u_t'), uMid = u('u_mid'), uLight = u('u_light'), uRs = u('u_rs');
    const uMix = u('u_mix'), uMod = u('u_mod'), uCur = u('u_cur');
    const uWave = u('u_wave'), uWexp = u('u_wexp'), uCalm = u('u_calm');
    gl.uniform1i(u('u_noise'), 0);
    return {
      resize(w, h, calm = 1) {
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform1f(uCalm, calm);
        gl.uniform2f(uRes, w, h);
        gl.uniform1f(uAspect, w / h);
        gl.uniform1f(uRs, radiusScale(w / h));
        gl.uniform1f(uWexp, wavePeakExponent(w / h));
      },
      draw(t, pal, wave = NO_WAVE) {
        gl.uniform1f(uT, t);
        const m = mixAt(t), md = modulatorsAt(t), cu = currentAt(t);
        gl.uniform4f(uMix, m[0], m[1], m[2], m[3]);
        gl.uniform3f(uMod, md.ang, md.zoom, md.time);
        gl.uniform4f(uCur, cu.dx, cu.dy, cu.pos, cu.amp);
        gl.uniform1f(uWave, wave.amt);
        gl.uniform3f(uMid, pal.mid[0], pal.mid[1], pal.mid[2]);
        gl.uniform3f(uLight, pal.light[0], pal.light[1], pal.light[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
      dispose() {
        gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  } catch (e) {
    console.warn('dither backdrop: WebGL init failed, using Canvas 2D', e);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
}

function canvas2dRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  const th = noise();
  let k = 1;
  return {
    resize(w, h, calm = 1) { canvas.width = w; canvas.height = h; k = calm; },
    draw(t, pal) {
      const w = canvas.width, h = canvas.height, aspect = w / h;
      const img = ctx.createImageData(w, h);
      const d = img.data;
      for (let y = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        // threshold row in GL orientation (gl_FragCoord y grows upwards)
        const ty = ((h - 1 - y) % NOISE_N) * NOISE_N;
        for (let x = 0; x < w; x++) {
          const uu = (x + 0.5) / w;
          const [dL0, dM0] = densities(toneCurve(field(uu * aspect, v, aspect, t)), mottle(uu * aspect, v, t));
          const dL = dL0 * k, dM = Math.min(1 - dL, dM0 * k);
          const lvl = ditherLevel(dL, dM, (th[ty + (x % NOISE_N)]! + 0.5) / 256);
          const c = lvl === 0 ? null : lvl === 1 ? pal.mid : pal.light;
          const i = (y * w + x) * 4;
          d[i] = c ? c[0] : 0; d[i + 1] = c ? c[1] : 0; d[i + 2] = c ? c[2] : 0; d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
    dispose() { /* nothing to free */ },
  };
}

/* New-song wave: one shared start time for every backdrop on the page (app background and Now Playing). */
let waveStart = -Infinity;
let lastSongKey = '';
usePlayer.subscribe((s) => {
  const cur = currentItem(s.state);
  const key = cur ? `${s.state.index}:${cur.track.id}` : '';
  if (key && key !== lastSongKey) waveStart = performance.now();
  lastSongKey = key;
});
const currentWave = (): Wave => waveAt((performance.now() - waveStart) / 1000);

/** Fixed time used for the static (reduced-motion / fallback) frame: a nicely composed moment. */
const STILL_T = 23;

/** A preset colour (red/blue/purple/green/cycle) or a palette of its own (the album's colour). */
export type BackdropColour = DitherColour | DitherPalette;
const resolve = (c: BackdropColour, t: number): DitherPalette => (typeof c === 'string' ? paletteAt(c, t) : c);
/** Seconds for the dots to blend into a new colour (the next album's). */
const COLOUR_BLEND_S = 1.4;

/** `main`: the page's own backdrop (not Now Playing's), whose colour the logo follows. */
export function DitherBackdrop({ colour, main = false }: { colour: BackdropColour; main?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const colourRef = useRef(colour);
  colourRef.current = colour;
  const redraw = useRef<() => void>(() => {});
  const [gen, setGen] = useState(0);

  useEffect(() => {
    // the canvas is created per effect run (not by React) so a disposed / lost context is never reused,
    // e.g. by StrictMode's double effect in dev or after a context restore
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient__dither';
    el.appendChild(canvas);
    let renderer: Renderer | null = webglRenderer(canvas);
    const animated = renderer !== null;
    if (!renderer) renderer = canvas2dRenderer(canvas);
    if (!renderer) { canvas.remove(); return; }
    const r = renderer;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    // the 2D fallback is CPU-bound: draw it chunkier and never animate it
    let coarse = animated ? 0 : 1;
    let grain = useUi.getState().dots;
    const phone = window.matchMedia('(max-width: 899px)');
    let raf = 0, last = -Infinity, prev = 0, slow = 0, frames = 0;
    // 30 fps only while something is happening; ~12 fps is plenty for the slow drift.
    let playing = usePlayer.getState().state.status === 'playing';
    let nowPlayingOpen = useUi.getState().nowPlayingOpen;
    const offPlaying = usePlayer.subscribe((s) => { playing = s.state.status === 'playing'; });
    const offUi = useUi.subscribe((s) => {
      nowPlayingOpen = s.nowPlayingOpen;
      if (s.dots !== grain) { grain = s.dots; size(); redraw.current(); } // Settings → Dot size
    });
    // `?dither-t=40` starts the animation 40 s in (for screenshots/review of a given moment)
    let t0 = performance.now() - (Number(new URLSearchParams(location.search).get('dither-t')) || 0) * 1000;
    let hiddenAt = 0;
    const clock = () => (performance.now() - t0) / 1000;
    const still = () => reduce.matches || !animated;

    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = window.innerWidth, ch = window.innerHeight;
      const dot = dotSize(cw, ch, dpr, coarse, undefined, grain);
      const w = Math.max(1, Math.ceil((cw * dpr) / dot)), h = Math.max(1, Math.ceil((ch * dpr) / dot));
      r.resize(w, h, calmFor(grain, phone.matches));
      // integer upscale: each canvas pixel is exactly `dot` device pixels (the canvas may overhang the viewport by < 1 dot)
      canvas.style.width = `${(w * dot) / dpr}px`;
      canvas.style.height = `${(h * dot) / dpr}px`;
    };
    // the colour shown glides toward the wanted one, so an album change blends instead of jumping
    let shown: DitherPalette | null = null;
    let lastPaint = performance.now();
    const paint = () => {
      const t = still() ? STILL_T : clock();
      const want = resolve(colourRef.current, still() ? 0 : t);
      const now = performance.now();
      const k = shown && !still() ? 1 - Math.exp(-((now - lastPaint) / 1000) / (COLOUR_BLEND_S / 3)) : 1;
      lastPaint = now;
      shown = shown ? mixPalette(shown, want, k) : want;
      r.draw(t, shown, still() ? NO_WAVE : currentWave());
      if (main) publishBackdrop(shown);
    };
    redraw.current = paint;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // adaptive: if the page itself keeps dropping frames (>1/3 of rAF intervals over 40 ms), use bigger dots once
      const dt = now - prev; prev = now;
      if (coarse === 0 && dt < 500) {
        frames++; if (dt > 40) slow++;
        if (frames >= 120) { if (slow > 40) { coarse = 1; size(); } frames = slow = 0; }
      }
      const frameMs = backdropFrameMs(playing, nowPlayingOpen, currentWave().amt !== 0);
      if (now - last < frameMs - 2) return;
      last = now;
      paint();
    };
    const start = () => { if (!raf && !still() && document.visibilityState === 'visible') raf = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    // time stands still while the tab is hidden, so the forms carry on where they were instead of jumping
    const onVis = () => {
      if (document.visibilityState === 'visible') { if (hiddenAt) t0 += performance.now() - hiddenAt; hiddenAt = 0; start(); }
      else { hiddenAt = performance.now(); stop(); }
    };
    // the CPU fallback redraws a whole frame per resize, so let a window drag settle first
    let resizeTimer = 0;
    const onResize = () => {
      if (animated) { size(); paint(); return; }
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => { size(); paint(); }, 150);
    };
    const onMotion = () => { stop(); paint(); start(); };

    size();
    paint();
    start();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVis);
    reduce.addEventListener('change', onMotion);
    const lost = (e: Event) => { e.preventDefault(); stop(); };
    const restored = () => setGen((g) => g + 1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      stop();
      offPlaying();
      offUi();
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      reduce.removeEventListener('change', onMotion);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      redraw.current = () => {};
      if (main) publishBackdrop(null);
      r.dispose();
      canvas.remove();
    };
  }, [gen, main]);

  // colour change while static (reduced motion / fallback) needs a repaint; the animated loop picks it up itself
  useEffect(() => { redraw.current(); }, [colour]);

  return <div ref={host} />;
}
