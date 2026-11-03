import { describe, expect, it } from 'vitest';
import { ALBUM_KEY_CHOICES, DEFAULT_ALBUM_KEY, FIXED_KEYS, validAlbumKey } from './keys';

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
