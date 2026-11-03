import { describe, expect, it } from 'vitest';
import { DITHER_PALETTES } from './dither';
import { opposite, oppositePalette, waveField } from './waveCover';

describe('wave cover', () => {
  it('covers about 80% of the square', () => {
    const w = 100, f = waveField(2, w, w);
    const lit = f.filter((v) => v > 0.05).length / f.length;
    expect(lit).toBeGreaterThan(0.72);
    expect(lit).toBeLessThan(0.88);
    expect(f[0]).toBe(0); // top-left is above the surface
    expect(f[w * w - 1]).toBeGreaterThan(0);
  });
  it('uses the opposite colour', () => {
    const [r, g, b] = opposite([255, 0, 0]);
    expect(Math.round(r)).toBe(0);
    expect(Math.round(g)).toBe(255);
    expect(Math.round(b)).toBe(255);
    const p = oppositePalette(DITHER_PALETTES.blue);
    expect(p.light[0]).toBeGreaterThan(p.light[2]); // blue turns orange-ish
  });
});
