import { describe, expect, it } from 'vitest';
import { formatScoreValue, normalizeScore, scoreSuffix, scoreTone } from './scores';

describe('normalizeScore', () => {
  it('normalises different scales to 0..100', () => {
    expect(normalizeScore({ score: 84, scale: 100 })).toBe(84);
    expect(normalizeScore({ score: 8.1, scale: 10 })).toBe(81);
    expect(normalizeScore({ score: 4, scale: 5 })).toBe(80);
  });
  it('clamps and guards', () => {
    expect(normalizeScore({ score: 12, scale: 10 })).toBe(100);
    expect(normalizeScore({ score: -1, scale: 10 })).toBe(0);
    expect(normalizeScore({ score: 5, scale: 0 })).toBe(0);
  });
});

describe('scoreTone / format', () => {
  it('buckets', () => {
    expect(scoreTone(84)).toBe('high');
    expect(scoreTone(60)).toBe('mid');
    expect(scoreTone(20)).toBe('low');
  });
  it('prints native values', () => {
    expect(formatScoreValue({ score: 84, scale: 100 })).toBe('84');
    expect(formatScoreValue({ score: 8.1, scale: 10 })).toBe('8.1');
    expect(formatScoreValue({ score: 8, scale: 10 })).toBe('8.0');
    expect(scoreSuffix({ scale: 10 })).toBe('/10');
    expect(scoreSuffix({ scale: 100 })).toBe('');
  });
});
