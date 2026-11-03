/** Single-key shortcuts rune already uses everywhere (not while typing). */
export const FIXED_KEYS: { key: string; label: string; does: string }[] = [
  { key: ' ', label: 'Space', does: 'Play / pause' },
  { key: 'e', label: 'E', does: 'Volume down' },
  { key: 'r', label: 'R', does: 'Volume up' },
  { key: '1', label: '1', does: 'Previous song' },
  { key: '2', label: '2', does: 'Restart this song' },
  { key: '3', label: '3', does: 'Next song' },
  { key: 'z', label: 'Z', does: 'Home' },
  { key: 'x', label: 'X', does: 'Playlists' },
  { key: '/', label: '/', does: 'Search' },
];

const TAKEN = new Set(FIXED_KEYS.map((k) => k.key));

/** Keys the "go to the playing album" shortcut may use: letters and digits nothing else claims. */
export const ALBUM_KEY_CHOICES: string[] = [...'abcdefghijklmnopqrstuvwxyz0123456789'].filter((k) => !TAKEN.has(k));

export const DEFAULT_ALBUM_KEY = 'a';

/** A stored choice, or the default when it is missing or now taken; '' means off. */
export function validAlbumKey(v: unknown): string {
  if (v === '') return '';
  return typeof v === 'string' && ALBUM_KEY_CHOICES.includes(v) ? v : DEFAULT_ALBUM_KEY;
}
