import { describe, expect, it } from 'vitest';
import { DITHER_PALETTES } from './dither';
import { ditherGrid, logoDot, logoGrid, OUTSIDE, paintGrid, resampleTones, type ToneMap } from './ditherLogo';

const flat = (w: number, h: number, tone: number, inside = (_x: number, _y: number) => true): ToneMap => {
  const t = new Uint8Array(w * h).fill(tone), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x, y) ? 255 : 0;
  return { w, h, tone: t, mask: m };
};

describe('resampleTones', () => {
  it('keeps a flat tone and reports coverage', () => {
    const r = resampleTones(flat(8, 8, 128), 4, 4);
    expect(r.tone[0]).toBeCloseTo(128 / 255, 5);
    expect([...r.cover].every((c) => c === 1)).toBe(true);
  });
  it('averages tones over masked pixels only', () => {
    const m = flat(2, 1, 0);
    m.tone[0] = 255; m.tone[1] = 0; m.mask[1] = 0; // the masked-out pixel must not darken the cell
    const r = resampleTones(m, 1, 1);
    expect(r.tone[0]).toBeCloseTo(1, 5);
    expect(r.cover[0]).toBeCloseTo(0.5, 5);
  });
});

describe('ditherGrid', () => {
  const full = (v: number, n = 16) => ditherGrid(new Float32Array(n * n).fill(v), new Float32Array(n * n).fill(1), n, n, false);
  it('is pure black / pure mid / pure light at 0, 0.5 and 1', () => {
    expect(new Set(full(0))).toEqual(new Set([0]));
    expect(new Set(full(0.5))).toEqual(new Set([1]));
    expect(new Set(full(1))).toEqual(new Set([2]));
  });
  it('mixes only neighbouring levels, in proportion to the tone', () => {
    const g = full(0.75); // halfway between mid and light
    expect(new Set(g)).toEqual(new Set([1, 2]));
    const light = [...g].filter((v) => v === 2).length / g.length;
    expect(light).toBeGreaterThan(0.45);
    expect(light).toBeLessThan(0.55);
  });
  it('is transparent outside the cut-out', () => {
    const cover = new Float32Array(16); cover[5] = 1;
    const g = ditherGrid(new Float32Array(16).fill(1), cover, 4, 4, false);
    expect(g[5]).toBe(2);
    expect(g.filter((v) => v === OUTSIDE).length).toBe(15);
  });
  it('lifts black rim cells to mid but leaves the interior black', () => {
    const n = 7, cover = new Float32Array(n * n).fill(1);
    const g = ditherGrid(new Float32Array(n * n), cover, n, n, true);
    expect(g[3 * n + 3]).toBe(0);
    expect(g[0]).toBe(1);
    expect(g[3 * n]).toBe(1);
  });
  it('is deterministic', () => {
    expect(full(0.3)).toEqual(full(0.3));
  });
});

describe('logoGrid / logoDot / paintGrid', () => {
  it('uses ~1 CSS px dots on every screen', () => {
    expect(logoDot(1)).toBe(1);
    expect(logoDot(2)).toBe(2);
    expect(logoDot(1.5)).toBe(2);
    expect(logoGrid(36, 0.83, 1, 1)).toEqual({ w: 36, h: 30 });
    expect(logoGrid(36, 0.83, 2, 2)).toEqual({ w: 36, h: 30 });
  });
  it('paints black, mid, light and transparent', () => {
    const out = new Uint8ClampedArray(16);
    paintGrid(Uint8Array.from([0, 1, 2, OUTSIDE]), DITHER_PALETTES.blue, out);
    expect([...out.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...out.slice(4, 8)]).toEqual([...DITHER_PALETTES.blue.mid, 255]);
    expect([...out.slice(8, 12)]).toEqual([...DITHER_PALETTES.blue.light, 255]);
    expect(out[15]).toBe(0);
  });
});
