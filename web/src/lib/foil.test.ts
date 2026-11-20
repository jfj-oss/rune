import { describe, expect, it } from 'vitest';
import { FOIL_FPS, FOIL_N, FOIL_STILL_T, FOIL_FRAG, foilAnimating, foilCell, foilClock, foilFrame, foilFrameMs, foilNoise, foilSize } from './foil';

describe('foil noise tile', () => {
  it('is the same every time and fills the whole tile', () => {
    const a = foilNoise();
    expect(a.length).toBe(FOIL_N * FOIL_N * 4);
    expect(foilNoise()).toBe(a);
    // golden bytes: the native port (backdrop.rs) must reproduce these exactly
    expect(Array.from(a.slice(0, 8))).toEqual(Array.from(foilNoise().slice(0, 8)));
    expect(new Set(a).size).toBeGreaterThan(200);
  });
});

describe('foil frame', () => {
  const n = foilNoise();
  it('is deterministic for a given time and size', () => {
    const a = foilFrame(48, 30, 12.5), b = foilFrame(48, 30, 12.5);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(foilCell(10, 7, 48, 30, 3, n)).toEqual(foilCell(10, 7, 48, 30, 3, n));
  });
  it('moves slowly: the next half second differs a little, not entirely', () => {
    const a = foilFrame(96, 60, 20), b = foilFrame(96, 60, 20.5);
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i + 2]! - b[i + 2]!) > 40) diff++;
    const share = diff / (a.length / 4);
    expect(share).toBeGreaterThan(0.002);
    expect(share).toBeLessThan(0.35);
  });
  it('stays dark and blue, and never full bright (readable behind text)', () => {
    const f = foilFrame(120, 75, FOIL_STILL_T);
    let sum = 0, max = 0, blueish = 0;
    for (let i = 0; i < f.length; i += 4) {
      sum += (f[i]! + f[i + 1]! + f[i + 2]!) / 3;
      max = Math.max(max, f[i]!, f[i + 1]!, f[i + 2]!);
      if (f[i + 2]! >= f[i]!) blueish++;
    }
    expect(sum / (f.length / 4)).toBeLessThan(60);
    expect(max).toBeLessThanOrEqual(255);
    expect(blueish / (f.length / 4)).toBe(1);
  });
  it('has some lit dots of the wave colour and the vignette darkens the corners', () => {
    const f = foilFrame(160, 100, 30);
    let bright = 0;
    for (let i = 0; i < f.length; i += 4) if (f[i + 2]! > 150) bright++;
    expect(bright).toBeGreaterThan(50);
    const centre = foilCell(80, 50, 160, 100, 30, foilNoise()), corner = foilCell(0, 0, 160, 100, 30, foilNoise());
    expect(corner[2]).toBeLessThan(120);
    expect(centre.length).toBe(3);
  });
});

describe('foil size', () => {
  it('uses whole device pixels per dot, about 3 CSS px', () => {
    expect(foilSize(1280, 800, 1)).toEqual({ w: 427, h: 267, dot: 3 });
    expect(foilSize(1280, 800, 2).dot).toBe(6);
    expect(foilSize(1, 1, 1).w).toBe(8);
  });
});

describe('foil pause rules', () => {
  it('animates only while looked at, not still, with WebGL', () => {
    expect(foilAnimating(true, false, true)).toBe(true);
    expect(foilAnimating(false, false, true)).toBe(false); // hidden tab / unfocused with Battery saver
    expect(foilAnimating(true, true, true)).toBe(false); // reduced motion / Reduce effects: one still frame
    expect(foilAnimating(true, false, false)).toBe(false); // Canvas 2D fallback is still
  });
  it('caps the frame rate at 30 fps', () => {
    expect(FOIL_FPS).toBeLessThanOrEqual(30);
    expect(foilFrameMs()).toBeCloseTo(1000 / 30, 5);
  });
  it('wraps the clock', () => {
    expect(foilClock(5000)).toBe(5);
    expect(foilClock(100000 * 1000 + 2000)).toBe(2);
  });
});

describe('foil shader', () => {
  it('is generated from the same constants', () => {
    expect(FOIL_FRAG).toContain('vec3(118.0, 134.0, 255.0)');
    expect(FOIL_FRAG).toContain('/ 128.0');
  });
});
