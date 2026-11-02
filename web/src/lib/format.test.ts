import { describe, expect, it } from 'vitest';
import { formatDuration, formatTotalLength, initials } from './format';

describe('formatDuration', () => {
  it('formats m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(241_900)).toBe('4:01');
  });
  it('formats h:mm:ss from an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
  });
  it('is safe on bad input', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });
});

describe('formatTotalLength', () => {
  it('rounds to minutes', () => {
    expect(formatTotalLength(41 * 60_000 + 20_000)).toBe('41 min');
    expect(formatTotalLength(10_000)).toBe('1 min');
  });
  it('uses hours', () => {
    expect(formatTotalLength(72 * 60_000)).toBe('1 hr 12 min');
    expect(formatTotalLength(120 * 60_000)).toBe('2 hr');
  });
});

describe('initials', () => {
  it('skips articles', () => {
    expect(initials('The Marlowe Tides')).toBe('MT');
    expect(initials('Aster Vale')).toBe('AV');
    expect(initials('Cobalt')).toBe('C');
  });
});
