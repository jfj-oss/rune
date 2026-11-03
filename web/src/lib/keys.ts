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
  { key: 'f', label: 'F', does: 'Shuffle-play the open playlist' },
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

/** A key assigned to open a playlist. */
export interface PlaylistKey { id: string; name: string }
export type PlaylistKeys = Record<string, PlaylistKey>;

/** Letters and digits a playlist hotkey may use. */
export const isKeyChoice = (k: string): boolean => /^[a-z0-9]$/.test(k);

/** Who already has key `k` (null = free): a built-in shortcut, the album key, or another playlist. */
export function keyOwner(k: string, albumKey: string, playlists: PlaylistKeys, forId?: string): string | null {
  const fixed = FIXED_KEYS.find((f) => f.key === k);
  if (fixed) return fixed.does;
  if (albumKey && k === albumKey) return 'Go to the playing album';
  const p = playlists[k];
  if (p && p.id !== forId) return `the playlist “${p.name}”`;
  return null;
}

/** Keep only well-formed entries from storage. */
export function cleanPlaylistKeys(v: unknown): PlaylistKeys {
  const out: PlaylistKeys = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    const e = p as Partial<PlaylistKey> | null;
    if (isKeyChoice(k) && !FIXED_KEYS.some((f) => f.key === k) && e && typeof e.id === 'string' && typeof e.name === 'string') out[k] = { id: e.id, name: e.name };
  }
  return out;
}

/** While a hotkey button is listening for a key, the global shortcuts stand aside. */
export const keyCapture = { active: false };
