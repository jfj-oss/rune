import { useEffect, useRef, useState } from 'react';
import { looking, onLooking, stillQuery } from '../lib/effects';
import { FOIL_FRAG, FOIL_N, FOIL_STILL_T, FOIL_VERT, foilAnimating, foilClock, foilFrame, foilFrameMs, foilNoise, foilSize } from '../lib/foil';

/* "Foil waves" ambient (the default): flowing wave lines of stipple dots over a mottled icy-blue cloud on navy, like
   printed foil. A WebGL1 fragment shader (lib/foil.ts holds the maths and the GLSL) draws a low-res frame (~3 CSS px per
   dot) that is upscaled with `image-rendering: pixelated`; 30 fps cap, paused while the tab is hidden (or, with Battery
   saver, unfocused), one still frame under prefers-reduced-motion / Reduce effects. Without WebGL: that still frame
   drawn on a Canvas 2D. A dark tint sits over the canvas so text stays readable. */

interface Renderer { draw(t: number): void; resize(w: number, h: number): void; dispose(): void }

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  return s;
}

function webglRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
  if (!gl) return null;
  try {
    const prog = gl.createProgram()!;
    const vs = compile(gl, gl.VERTEX_SHADER, FOIL_VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FOIL_FRAG);
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
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FOIL_N, FOIL_N, 0, gl.RGBA, gl.UNSIGNED_BYTE, foilNoise());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    const uRes = gl.getUniformLocation(prog, 'u_res'), uT = gl.getUniformLocation(prog, 'u_t');
    gl.uniform1i(gl.getUniformLocation(prog, 'u_noise'), 0);
    return {
      resize(w, h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); gl.uniform2f(uRes, w, h); },
      draw(t) { gl.uniform1f(uT, t); gl.drawArrays(gl.TRIANGLES, 0, 3); },
      dispose() {
        gl.deleteTexture(tex); gl.deleteBuffer(buf); gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      },
    };
  } catch (e) {
    console.warn('foil backdrop: WebGL init failed, using Canvas 2D', e);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }
}

function canvas2dRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  return {
    resize(w, h) { canvas.width = w; canvas.height = h; },
    draw(t) { ctx.putImageData(new ImageData(foilFrame(canvas.width, canvas.height, t), canvas.width, canvas.height), 0, 0); },
    dispose() { /* nothing to free */ },
  };
}

export function FoilBackdrop() {
  const host = useRef<HTMLDivElement>(null);
  const redraw = useRef<() => void>(() => {});
  const [gen, setGen] = useState(0);

  useEffect(() => {
    // the canvas is created per effect run so a lost / disposed context is never reused (StrictMode, context restore)
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ambient__foil';
    el.prepend(canvas);
    let renderer: Renderer | null = webglRenderer(canvas);
    const gl = renderer !== null;
    if (!renderer) renderer = canvas2dRenderer(canvas);
    if (!renderer) { canvas.remove(); return; }
    const r = renderer;
    const reduce = stillQuery();
    let raf = 0, last = -Infinity;
    // `?foil-t=40` starts the animation 40 s in (for screenshots of a given moment)
    let t0 = performance.now() - (Number(new URLSearchParams(location.search).get('foil-t')) || 0) * 1000;
    let hiddenAt = 0;
    const clock = () => foilClock(performance.now() - t0);
    const still = () => reduce.matches || !gl;
    const paint = () => r.draw(still() ? FOIL_STILL_T : clock());
    redraw.current = paint;
    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      const { w, h, dot } = foilSize(window.innerWidth, window.innerHeight, dpr);
      r.resize(w, h);
      // integer upscale: each canvas pixel is exactly `dot` device pixels
      canvas.style.width = `${(w * dot) / dpr}px`;
      canvas.style.height = `${(h * dot) / dpr}px`;
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < foilFrameMs() - 2) return;
      last = now;
      paint();
    };
    const run = () => foilAnimating(looking(), still(), gl);
    const start = () => { if (!raf && run()) raf = requestAnimationFrame(loop); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    // time stands still while hidden, so the waves carry on where they were instead of jumping
    const onVis = () => {
      if (run()) { if (hiddenAt) t0 += performance.now() - hiddenAt; hiddenAt = 0; start(); }
      else { if (!hiddenAt) hiddenAt = performance.now(); stop(); }
    };
    let resizeTimer = 0;
    const onResize = () => { if (gl) { size(); paint(); return; } clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { size(); paint(); }, 150); };
    const onMotion = () => { stop(); paint(); onVis(); };
    size();
    paint();
    start();
    window.addEventListener('resize', onResize);
    const offLooking = onLooking(onVis);
    reduce.addEventListener('change', onMotion);
    const lost = (e: Event) => { e.preventDefault(); stop(); };
    const restored = () => setGen((g) => g + 1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      stop();
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', onResize);
      offLooking();
      reduce.removeEventListener('change', onMotion);
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      redraw.current = () => {};
      r.dispose();
      canvas.remove();
    };
  }, [gen]);

  return <div ref={host}><div className="ambient__foiltint" /></div>;
}
