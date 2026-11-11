import { describe, expect, it } from 'vitest';
import { restingNotice } from './spotify';

describe('restingNotice (Spotify’s daily limit, said plainly)', () => {
  it('names the time Spotify answers again, and says nothing once it has passed', () => {
    const now = Date.UTC(2026, 10, 10, 12, 0, 0);
    const until = now + 2 * 3_600_000;
    const text = restingNotice(until, now);
    expect(text).toMatch(/^Spotify is resting until \d{1,2}:\d{2}/);
    expect(text).toMatch(/local music works now/i);
    expect(restingNotice(until, until)).toBeNull();
    expect(restingNotice(null, now)).toBeNull();
  });
});
