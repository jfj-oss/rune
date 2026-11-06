import { describe, expect, it } from 'vitest';
import { ALBUM_KEY_CHOICES, cleanPlaylistKeys, DEFAULT_ALBUM_KEY, FIXED_KEYS, keyOwner, leavingOverlays, skipAheadMs, validAlbumKey } from './keys';

describe('album key choices', () => {
  it('leave out every key rune already uses', () => {
    for (const k of FIXED_KEYS) expect(ALBUM_KEY_CHOICES).not.toContain(k.key);
    for (const k of ['z', 'x', 'e', 'r', '1', '2', '3']) expect(ALBUM_KEY_CHOICES).not.toContain(k);
    expect(ALBUM_KEY_CHOICES).toContain('a');
    expect(ALBUM_KEY_CHOICES).toContain('9');
  });
  it('fall back to the default for missing or taken keys, keep off', () => {
    expect(validAlbumKey(undefined)).toBe(DEFAULT_ALBUM_KEY);
    expect(validAlbumKey('z')).toBe(DEFAULT_ALBUM_KEY);
    expect(validAlbumKey('w')).toBe('w');
    expect(validAlbumKey('')).toBe('');
  });
});

describe('keys that leave the page', () => {
  it('close Now Playing and the queue before going', () => {
    const steps: string[] = [];
    leavingOverlays(
      { setNowPlayingOpen: (o) => steps.push(`nowPlaying:${o}`), setQueueOpen: (o) => steps.push(`queue:${o}`) },
      () => steps.push('go'),
    );
    expect(steps).toEqual(['nowPlaying:false', 'queue:false', 'go']);
  });
});

describe('playlist hotkeys', () => {
  const pls = { p: { id: 'rp:1', name: 'Gym' } };
  it('says who owns a key', () => {
    expect(keyOwner('z', 'a', pls)).toBe('Home');
    expect(keyOwner('a', 'a', pls)).toBe('Go to the playing album');
    expect(keyOwner('p', 'a', pls)).toBe('the playlist “Gym”');
    expect(keyOwner('p', 'a', pls, 'rp:1')).toBeNull();
    expect(keyOwner('w', 'a', pls)).toBeNull();
    expect(keyOwner('q', 'a', pls)).toBe('Back');
  });
  it('drops bad stored entries', () => {
    expect(cleanPlaylistKeys({ p: { id: 'x', name: 'X' }, z: { id: 'y', name: 'Y' }, '!': { id: 'w', name: 'W' }, q: 5 })).toEqual({ p: { id: 'x', name: 'X' } });
    expect(cleanPlaylistKeys(null)).toEqual({});
  });
});

describe('key 4: skip a fifth of the song', () => {
  it('moves 20% of the song on from wherever it is', () => {
    expect(skipAheadMs(0, 100_000)).toBe(20_000);
    expect(skipAheadMs(33_000, 100_000)).toBe(53_000);
  });
  it('goes to the next song past the end', () => {
    expect(skipAheadMs(85_000, 100_000)).toBeNull();
    expect(skipAheadMs(79_500, 100_000)).toBeNull();
  });
});
