import { describe, expect, it } from 'vitest';
import { shownVolume } from './volumeHold';

describe('shownVolume', () => {
  it('shows the held choice until it expires, then the reported level', () => {
    expect(shownVolume(62, { v: 45, until: 2000 }, 1000)).toBe(45); // stale report ignored
    expect(shownVolume(62, { v: 45, until: 2000 }, 2500)).toBe(62);
    expect(shownVolume(62, { v: null, until: 0 }, 1000)).toBe(62);
  });
});
