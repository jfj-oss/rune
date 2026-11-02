// Pure title/artist matching for mapping ListenBrainz recordings onto Spotify
// search results. Deliberately conservative: never map a cover or a different
// song just because Spotify's search returned something.
import { normalizeName } from '../db/index.js';

/**
 * Normalized title equality, allowing a decorated version of the same title:
 * "Creep" matches "Creep (Remastered)" / "Creep - Live", but not "Creepin'".
 */
export function titleMatches(wanted: string, got: string): boolean {
  const w = normalizeName(wanted);
  const g = normalizeName(got);
  if (!w || !g) return false;
  if (w === g) return true;
  return g.startsWith(w + ' ') || w.startsWith(g + ' ');
}

/**
 * One of `got` must be the wanted artist. `wanted` may be a join credit
 * ("Daft Punk, Pharrell Williams"), so a single Spotify artist contained in the
 * full credit counts. The reverse (a longer Spotify artist containing the wanted
 * name) does *not* count: "Nirvana UK" is not "Nirvana".
 */
export function artistMatches(wanted: string, got: string[]): boolean {
  const w = normalizeName(wanted);
  if (!w) return false;
  return got.some((name) => {
    const n = normalizeName(name);
    if (!n) return false;
    return n === w || (n.length >= 2 && w.includes(n));
  });
}

/** Stable key for "same artist + same title" exclusion checks. */
export function ownedKey(artist: string, title: string): string {
  return `${normalizeName(artist)}\u0000${normalizeName(title)}`;
}
