import { describe, expect, it } from 'vitest';
import { ballsAt, brightness, cubicBezier, ditherLevels, LOOP_MS } from './dotLogo';

const corners = (ms: number) => ballsAt(ms).map((b) => `${b.x.toFixed(2)},${b.y.toFixed(2)}`).sort();

describe('dot logo motion', () => {
  it('rests on the four corners and swaps a pair without changing the picture', () => {
    expect(corners(0)).toEqual(corners(LOOP_MS * 0.45));
    expect(corners(0)).toEqual(corners(LOOP_MS * 0.95));
    expect(new Set(corners(0)).size).toBe(4);
  });
  it('moves only one pair at a time', () => {
    const rest = ballsAt(0), midA = ballsAt(LOOP_MS * 0.2), midB = ballsAt(LOOP_MS * 0.7);
    const moved = (a: typeof rest, b: typeof rest) => a.map((p, i) => Math.hypot(p.x - b[i]!.x, p.y - b[i]!.y) > 0.01);
    expect(moved(rest, midA)).toEqual([true, true, false, false]);
    expect(moved(ballsAt(LOOP_MS * 0.45), midB)).toEqual([false, false, true, true]);
  });
  it('eases with a small overshoot', () => {
    const e = cubicBezier(0.72, 0, 0.18, 1.14);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => e(i / 50)))).toBeGreaterThan(1);
  });
});

describe('dot logo dither', () => {
  it('is see-through away from the balls and a speckle of light over mid on them, like the backdrop', () => {
    const w = 40;
    const lv = ditherLevels(brightness(0, w, w), w, w);
    expect(lv[0]).toBe(0);
    const b = ballsAt(0)[0]!;
    const r = Math.floor(b.r * w * 0.5);
    const around: number[] = [];
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) around.push(lv[(Math.floor(b.y * w) + y) * w + Math.floor(b.x * w) + x]!);
    expect(around).toContain(2);
    expect(around).toContain(1);
    expect(around.filter((l) => l === 2).length).toBeLessThan(around.length / 2);
  });
});
