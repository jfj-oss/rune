import { describe, expect, it } from 'vitest';
import { ALBUM_KEY_CHOICES, cleanPlaylistKeys, DEFAULT_ALBUM_KEY, FIXED_KEYS, keyOwner, validAlbumKey } from './keys';

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
    expect(validAlbumKey('q')).toBe('q');
    expect(validAlbumKey('')).toBe('');
  });
});

describe('playlist hotkeys', () => {
  const pls = { p: { id: 'rp:1', name: 'Gym' } };
  it('says who owns a key', () => {
    expect(keyOwner('z', 'a', pls)).toBe('Home');
    expect(keyOwner('a', 'a', pls)).toBe('Go to the playing album');
    expect(keyOwner('p', 'a', pls)).toBe('the playlist “Gym”');
    expect(keyOwner('p', 'a', pls, 'rp:1')).toBeNull();
    expect(keyOwner('q', 'a', pls)).toBeNull();
  });
  it('drops bad stored entries', () => {
    expect(cleanPlaylistKeys({ p: { id: 'x', name: 'X' }, z: { id: 'y', name: 'Y' }, '!': { id: 'w', name: 'W' }, q: 5 })).toEqual({ p: { id: 'x', name: 'X' } });
    expect(cleanPlaylistKeys(null)).toEqual({});
  });
});
