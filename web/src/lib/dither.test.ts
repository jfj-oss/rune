import { describe, expect, it } from 'vitest';
import {
  bayer, blueNoise, CYCLE_FADE, CYCLE_HOLD, CYCLE_ORDER, DITHER_PALETTES, calmFor, ditherLevel, dotSize, field, paletteAt,
  densities, MASK, toneCurve, mixAt, modulatorsAt, currentAt, EVOLVE,
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
    for (const [name, p] of Object.entries(DITHER_PALETTES)) {
      const [dL, dM] = densities(1);
      const mean = dL * lum(p.light) + dM * lum(p.mid);
      // olive and lime are the user's picks, taken as-is from album pages' colours (album colours are not capped): olive ~3.6:1, lime ~3.2:1
      expect((0.551 + 0.05) / (mean + 0.05)).toBeGreaterThanOrEqual(name === 'olive' || name === 'lime' ? 3.2 : 4.5);
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
  it('fine grain is smaller than classic and respects its pixel budget', () => {
    expect(dotSize(1280, 800, 1, 0, undefined, 'fine')).toBe(1);
    expect(dotSize(1280, 800, 2, 0, undefined, 'fine')).toBe(3);
    expect(dotSize(390, 844, 3, 0, undefined, 'fine')).toBe(4);
    expect(dotSize(390, 844, 3, 1, undefined, 'fine')).toBeGreaterThan(4);
    const d = dotSize(3840, 2160, 2, 0, undefined, 'fine');
    expect((3840 * 2 / d) * (2160 * 2 / d)).toBeLessThanOrEqual(2_200_000);
    expect(calmFor('fine', true)).toBeLessThan(1);
    expect(calmFor('classic', true)).toBe(1);
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

describe('waveAt', () => {
  it('swells out, rests at the peak, then draws back in faster and faster to rest', async () => {
    const { waveAt, WAVE } = await import('./dither');
    expect(waveAt(-1).amt).toBe(0);
    expect(waveAt(0).amt).toBeCloseTo(0, 5);
    expect(waveAt(WAVE.rise * 0.5).dir).toBe(1);
    expect(WAVE.length).toBeCloseTo(12.4, 5);
    // the way out starts gently too: the first quarter grows less than the second
    const out = (q: number) => waveAt(q * WAVE.rise).amt;
    expect(out(0.25)).toBeLessThan(out(0.5) - out(0.25));
    // resting at the peak
    expect(waveAt(WAVE.rise + 0.01).amt).toBe(1);
    expect(waveAt(WAVE.rise + WAVE.hold - 0.01).amt).toBe(1);
    expect(waveAt(WAVE.rise + WAVE.hold * 0.5).dir).toBe(0);
    // the way back starts gently too: the drop in the first quarter is smaller than in the second
    const at = (q: number) => waveAt(WAVE.rise + WAVE.hold + q * WAVE.fall).amt;
    expect(1 - at(0.25)).toBeLessThan(at(0.25) - at(0.5));
    expect(waveAt(WAVE.rise + WAVE.hold + 0.1).dir).toBe(-1);
    // it reaches rest still moving (the crash) ...
    expect(at(0.95)).toBeGreaterThan(0.05);
    // ... then bounces: dips below rest, comes back a little above it, and ends exactly at rest
    const b0 = WAVE.rise + WAVE.hold + WAVE.fall;
    const bounce = Array.from({ length: 400 }, (_, i) => waveAt(b0 + (i / 400) * WAVE.bounce).amt);
    const low = Math.min(...bounce), lowAt = bounce.indexOf(low);
    const high = Math.max(...bounce.slice(lowAt));
    expect(low).toBeLessThan(-0.1);
    expect(low).toBeGreaterThan(-0.25);
    expect(high).toBeGreaterThan(0.02);
    expect(high).toBeLessThan(-low);
    // no kink where the crash turns into the bounce: same speed on both sides
    const e = 1e-3;
    const before = (waveAt(b0 - e).amt - waveAt(b0 - 2 * e).amt) / e;
    const after = (waveAt(b0 + 2 * e).amt - waveAt(b0 + e).amt) / e;
    expect(Math.abs(before - after)).toBeLessThan(0.02);
    expect(Math.abs(waveAt(WAVE.length - 0.01).amt)).toBeLessThan(0.002);
    expect(waveAt(WAVE.length).amt).toBe(0);
  });

  it('grows the covered area evenly with the swell (no rush at the end)', async () => {
    const { field, toneCurve, wavePeakExponent } = await import('./dither');
    const aspect = 1.6, ep = wavePeakExponent(aspect);
    const cov = (amt: number) => {
      let on = 0, n = 0;
      for (const t of [5, 40, 77]) for (let y = 0; y < 24; y++) for (let x = 0; x < 40; x++) {
        const f = Math.max(0, field(((x + 0.5) / 40) * aspect, (y + 0.5) / 24, aspect, t));
        if (toneCurve(Math.pow(f, Math.pow(ep, amt))) > 0.4) on++;
        n++;
      }
      return on / n;
    };
    const steps = [0, 0.25, 0.5, 0.75, 1].map(cov);
    const gains = steps.slice(1).map((v, i) => v - steps[i]!);
    // no quarter of the swell does more than twice the growth of another
    expect(Math.max(...gains) / Math.min(...gains)).toBeLessThan(2);
  });

  it('lifts the field enough to cover ~80% of desktop and phone screens at the peak', async () => {
    const { field, toneCurve, wavePeakExponent } = await import('./dither');
    for (const aspect of [1.6, 0.46]) {
      const e = wavePeakExponent(aspect);
      let on = 0, n = 0;
      for (const t of [5, 23, 40, 77, 120]) {
        for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) {
          const f = Math.max(0, field(((x + 0.5) / 60) * aspect, (y + 0.5) / 40, aspect, t));
          if (toneCurve(Math.pow(f, e)) > 0.4) on++; // clearly filled, not stray dots
          n++;
        }
      }
      expect(on / n).toBeGreaterThan(0.79);
      expect(on / n).toBeLessThan(0.88);
    }
  });
});

describe('paletteFromColour', () => {
  it('keeps the cover hue, at a fixed brightness; greys and junk handled', async () => {
    const { paletteFromColour, parseCssColour } = await import('./dither');
    const red = paletteFromColour('rgb(200 40 40)')!;
    expect(red.light[0]).toBeGreaterThan(red.light[1]! + 60);
    expect(red.mid[0]).toBeLessThan(red.light[0]!);
    const blue = paletteFromColour('hsl(220 40% 30%)')!;
    expect(blue.light[2]).toBeGreaterThan(blue.light[0]!);
    const grey = paletteFromColour('rgb(120, 120, 122)')!;
    expect(Math.abs(grey.light[0]! - grey.light[2]!)).toBeLessThan(40);
    expect(paletteFromColour('nonsense')).toBeNull();
    expect(parseCssColour('rgb(1, 2, 3)')).toEqual([1, 2, 3]);
  });
});

describe('evolution schedule', () => {
  const sum = (m: number[]) => m.reduce((a, b) => a + b, 0);
  it('starts as pure drift and holds it for the first minute', () => {
    expect(mixAt(0)).toEqual([1, 0, 0, 0]);
    expect(mixAt(-5)).toEqual([1, 0, 0, 0]);
    expect(mixAt(EVOLVE.firstEnd - 40)).toEqual([1, 0, 0, 0]);
  });
  it('weights always sum to 1 and never jump (smooth crossfades)', () => {
    let prev = mixAt(0);
    for (let t = 0.5; t < 6000; t += 0.5) {
      const m = mixAt(t);
      expect(sum(m)).toBeCloseTo(1, 9);
      for (const w of m) expect(w).toBeGreaterThanOrEqual(0);
      // a 20 s+ smoothstep fade moves at most 1.5 / 20 = 7.5 % of the weight per second
      for (let i = 0; i < 4; i++) expect(Math.abs(m[i]! - prev[i]!)).toBeLessThan(0.08 * 0.5 + 0.002);
      prev = m;
    }
  });
  it('visits every character, never two crossfades at once, and is deterministic', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 6000; t += 5) {
      const m = mixAt(t);
      expect(m.filter((w) => w > 0).length).toBeLessThanOrEqual(2);
      m.forEach((w, i) => { if (w > 0.999) seen.add(i); });
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(mixAt(1234.5)).toEqual(mixAt(1234.5));
  });
  it('is not a fixed loop: segment lengths vary', () => {
    const changes: number[] = [];
    let cur = -1;
    for (let t = 0; t < 4000; t += 1) { const k = mixAt(t).findIndex((w) => w > 0.999); if (k >= 0 && k !== cur) { changes.push(t); cur = k; } }
    const gaps = changes.slice(1).map((v, i) => v - changes[i]!);
    expect(new Set(gaps).size).toBeGreaterThan(3);
    expect(Math.min(...gaps)).toBeGreaterThan(60);
  });
  it('modulators and currents stay small and smooth', () => {
    let prev = modulatorsAt(0);
    for (let t = 1; t < 3000; t++) {
      const m = modulatorsAt(t);
      expect(Math.abs(m.ang)).toBeLessThan(0.7);
      expect(m.zoom).toBeGreaterThan(0.84);
      expect(m.zoom).toBeLessThan(1.16);
      expect(m.time - prev.time).toBeGreaterThan(0.6); // the warped clock never runs backwards or stalls
      expect(m.time - prev.time).toBeLessThan(1.4);
      prev = m;
      const c = currentAt(t);
      expect(c.amp).toBeGreaterThanOrEqual(0);
      expect(c.amp).toBeLessThanOrEqual(0.23);
      expect(Math.hypot(c.dx, c.dy)).toBeCloseTo(1, 9);
    }
  });
  it('currents are occasional and fade in and out', () => {
    let on = 0, off = 0;
    for (let k = 0; k < 40; k++) { const mid = currentAt((k + 0.5) * 95).amp; if (mid > 0.05) on++; else off++; expect(currentAt(k * 95 + 0.01).amp).toBeLessThan(0.001); }
    expect(on).toBeGreaterThan(5);
    expect(off).toBeGreaterThan(3);
  });
});
