import { describe, expect, it } from 'vitest';
import {
  bayer, blueNoise, CYCLE_FADE, CYCLE_HOLD, CYCLE_ORDER, DITHER_PALETTES, ditherLevel, dotSize, field, paletteAt,
  densities, MASK, toneCurve,
} from './dither';

describe('bayer', () => {
  it('2x2 and 4x4 match the classic matrices', () => {
    expect(bayer(2)).toEqual([0, 2, 3, 1]);
    expect(bayer(4)).toEqual([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]);
  });
  it('8x8 is a permutation of 0..63', () => {
    expect([...bayer(8)].sort((a, b) => a - b)).toEqual(Array.from({ length: 64 }, (_, i) => i));
  });
  it('rejects non powers of two', () => {
    expect(() => bayer(6)).toThrow();
  });
});

describe('blueNoise', () => {
  const n = 16;
  const rank = blueNoise(n, 3);
  it('is a permutation of all ranks', () => {
    expect([...rank].sort((a, b) => a - b)).toEqual(Array.from({ length: n * n }, (_, i) => i));
  });
  it('is deterministic for a seed', () => {
    expect(blueNoise(n, 3)).toEqual(rank);
  });
  it('spreads the darkest 10% evenly (no two horizontally/vertically adjacent)', () => {
    const k = Math.floor(n * n * 0.1);
    const on = (x: number, y: number) => rank[((y + n) % n) * n + ((x + n) % n)]! < k;
    let touching = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (on(x, y) && (on(x + 1, y) || on(x, y + 1))) touching++;
    expect(touching).toBe(0);
  });
});

describe('ditherLevel + densities', () => {
  const th = Array.from({ length: 1024 }, (_, i) => (i + 0.5) / 1024);
  const share = (dL: number, dM: number, lvl: number) => th.filter((t) => ditherLevel(dL, dM, t) === lvl).length / th.length;
  it('splits pixels into exactly the requested shares', () => {
    expect(share(0.3, 0.45, 2)).toBeCloseTo(0.3, 2);
    expect(share(0.3, 0.45, 1)).toBeCloseTo(0.45, 2);
    expect(share(0.3, 0.45, 0)).toBeCloseTo(0.25, 2);
  });
  it('tone 0 is pure black; a full body is capped light grain on the mid tone, no black holes', () => {
    expect(densities(0)).toEqual([0, 0]);
    const [dL, dM] = densities(1);
    expect(dL).toBeCloseTo(MASK.light, 9);
    expect(dL + dM).toBeCloseTo(1, 9);
  });
  it('shares are capped, never exceed 1 in total, and grow with tone', () => {
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) for (const g of [0.66, 0.8, 1, 1.06]) {
      const [dL, dM] = densities(t, g);
      expect(dL + dM).toBeLessThanOrEqual(1 + 1e-9);
      expect(dL).toBeLessThanOrEqual(MASK.light + 1e-9);
      expect(dM).toBeLessThanOrEqual(MASK.mid + 1e-9);
      if (g === 1) { expect(dL + dM).toBeGreaterThanOrEqual(prev); prev = dL + dM; }
    }
  });
});

describe('tone + readability', () => {
  it('tone is monotonic in the field and stays in 0..1', () => {
    let prev = -1;
    for (let f = 0; f <= 2; f += 0.05) {
      const t = toneCurve(f);
      expect(t).toBeGreaterThanOrEqual(prev);
      expect(t).toBeLessThanOrEqual(1);
      prev = t;
    }
    expect(toneCurve(0)).toBe(0);
    expect(toneCurve(5)).toBe(1);
  });
  it('content caps keep the mean backdrop dark enough for AA secondary text', () => {
    // dither-mode secondary text is #c2c3d1 (L 0.551): the mean backdrop luminance at the caps must give >= 4.5:1
    const lum = (c: readonly number[]) => c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
      .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    for (const p of Object.values(DITHER_PALETTES)) {
      const [dL, dM] = densities(1);
      const mean = dL * lum(p.light) + dM * lum(p.mid);
      expect((0.551 + 0.05) / (mean + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('field is finite and non-negative', () => {
    for (let i = 0; i < 50; i++) {
      const v = field((i % 10) / 5, (i / 50), 1.6, i * 3.7);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('paletteAt', () => {
  it('returns fixed palettes for fixed colours', () => {
    expect(paletteAt('blue', 999)).toBe(DITHER_PALETTES.blue);
  });
  it('cycle holds each colour and loops', () => {
    const step = CYCLE_HOLD + CYCLE_FADE;
    CYCLE_ORDER.forEach((c, i) => expect(paletteAt('cycle', i * step + 5).light).toEqual(DITHER_PALETTES[c].light));
    expect(paletteAt('cycle', step * CYCLE_ORDER.length + 5).light).toEqual(DITHER_PALETTES.red.light);
    const mid = paletteAt('cycle', CYCLE_HOLD + CYCLE_FADE / 2).light;
    expect(mid).not.toEqual(DITHER_PALETTES.red.light);
    expect(mid).not.toEqual(DITHER_PALETTES.purple.light);
  });
});

describe('dotSize', () => {
  it('is ~2 CSS px in device pixels and grows on huge canvases', () => {
    expect(dotSize(1600, 1000, 1)).toBe(2);
    expect(dotSize(1600, 1000, 2)).toBe(4);
    expect(dotSize(1600, 1000, 1, 1)).toBe(3);
    const d = dotSize(3840, 2160, 2);
    expect((3840 * 2 / d) * (2160 * 2 / d)).toBeLessThanOrEqual(600_000);
  });
});

describe('ditherHueOf', () => {
  it('maps cover colours to the nearest dither hue', async () => {
    const { ditherHueOf } = await import('./dither');
    expect(ditherHueOf('rgb(200 60 50)')).toBe('red');
    expect(ditherHueOf('rgb(220, 160, 40)')).toBe('red');
    expect(ditherHueOf('rgb(40 160 70)')).toBe('green');
    expect(ditherHueOf('rgb(40 90 220)')).toBe('blue');
    expect(ditherHueOf('rgb(140 70 220)')).toBe('purple');
    expect(ditherHueOf('hsl(210 40% 30%)')).toBe('blue');
    expect(ditherHueOf('rgb(120 120 125)')).toBeNull();
    expect(ditherHueOf('nonsense')).toBeNull();
  });
});
