// Search-query variants for MusicBrainz matching.
//
// Local tags are unreliable: a folder may say "Volez Vous" for ABBA's
// "Voulez-vous", a title tag may carry scene junk ("[320] kbps Beats[TGx]"),
// an edition suffix or a disc prefix, or the album artist may be the composer
// while the tags name the game/film. The plain Lucene phrase search only finds
// exact tag text, so we generate a small ordered set of variants and merge the
// results. The exact old query stays first so cached responses and recorded
// fixtures keep working.
import { basename } from 'node:path';
import { cleanFolderName } from '../scan/names.js';
import {
  isGenericArtist,
  isPlaceholderTitle,
  isSoundtrackAlbum,
  normalizeTitle,
  type LocalAlbumForMatch,
} from './scoring.js';

export interface ReleaseQuery {
  title: string;
  /** Empty/undefined = search by release title only. */
  artist?: string;
  /** Optional `tracks:N` constraint; finds a specific edition by size. */
  trackCount?: number;
}

/** Fold the punctuation variants that break Lucene phrase searches. */
export function querySafe(value: string): string {
  return (
    value
      // Map apostrophe look-alikes *before* NFKD: U+00B4 decomposes into a
      // space + combining acute, which would split "Day´s" into "Day s".
      .replace(/[‘’‛′´`]/g, "'")
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[‐-―−]/g, '-')
      .replace(/&/g, ' and ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

const DISC_PREFIX_RE = /^\s*(?:cd|disc|disk)\s*(?:\d+|one|two|three|four|five|six)\s*[-–—:.]\s*/i;

function addUnique(list: string[], value: string | undefined): void {
  const v = value?.trim();
  if (!v) return;
  const key = v.toLowerCase();
  if (list.some((existing) => existing.toLowerCase() === key)) return;
  list.push(v);
}

function cleanFolderParts(local: LocalAlbumForMatch): { artist?: string; album?: string } {
  const folder = local.folderPath?.trim();
  if (!folder) return {};
  const cleaned = cleanFolderName(basename(folder));
  return {
    ...(cleaned.artist ? { artist: cleaned.artist } : {}),
    ...(cleaned.album ? { album: cleaned.album } : {}),
  };
}

/**
 * Album-title variants in priority order. The raw tag title is always first
 * (byte-identical to the pre-variant matcher, so existing cache entries and
 * fixtures still replay); later entries are progressively cleaner guesses.
 */
export function titleVariants(local: LocalAlbumForMatch): string[] {
  const out: string[] = [];
  const raw = local.title.trim();
  const folder = cleanFolderParts(local);

  addUnique(out, raw);

  const safe = querySafe(raw);
  addUnique(out, safe);

  // Edition/remaster/soundtrack/disc noise stripped ("Born in the Echoes
  // [Deluxe Edition]" → "born in the echoes").
  addUnique(out, normalizeTitle(raw));

  // "Disc 1 - Firefall" / "CD2 - ..." → the underlying album title.
  addUnique(out, raw.replace(DISC_PREFIX_RE, ''));
  addUnique(out, normalizeTitle(raw.replace(DISC_PREFIX_RE, '')));

  // Scene junk, catalog numbers and quality tags in the *tag* title:
  // "City To City ( GZS-1075 )", "Ten Summoner's Tales (PBTHAL 24-96)".
  const scrubbed = cleanFolderName(`x - ${raw}`).album;
  addUnique(out, scrubbed);
  addUnique(out, scrubbed ? normalizeTitle(scrubbed) : undefined);

  // The folder name is often cleaner than the embedded tags.
  addUnique(out, folder.album);
  addUnique(out, folder.album ? normalizeTitle(folder.album) : undefined);

  // A title tag that repeats the artist ("2Pac Me Against The World").
  const artist = local.artist.trim();
  if (artist && raw.toLowerCase().startsWith(`${artist.toLowerCase()} `)) {
    const withoutArtist = raw.slice(artist.length).trim();
    addUnique(out, withoutArtist);
    addUnique(out, normalizeTitle(withoutArtist));
  }

  return out.filter((title) => !isPlaceholderTitle(title)).slice(0, 8);
}

/** Album-artist variants: raw tag, punctuation-folded tag, cleaned folder artist. */
export function artistVariants(local: LocalAlbumForMatch): string[] {
  const out: string[] = [];
  addUnique(out, local.artist);
  addUnique(out, querySafe(local.artist));
  addUnique(out, cleanFolderParts(local).artist);
  return out.filter((name) => !isGenericArtist(name)).slice(0, 3);
}

/**
 * Ordered release-search queries. For soundtracks/compilations a title-only
 * search comes first (the tagged "artist" is often a game/film name); for
 * normal albums the exact tag pair stays first.
 */
export function releaseQueries(local: LocalAlbumForMatch): ReleaseQuery[] {
  const titles = titleVariants(local);
  const artists = artistVariants(local);
  const queries: ReleaseQuery[] = [];
  const seen = new Set<string>();
  const push = (q: ReleaseQuery): void => {
    if (!q.title.trim()) return;
    const key = `${q.title.toLowerCase()}\u0000${(q.artist ?? '').toLowerCase()}\u0000${q.trackCount ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(q);
  };

  const soundtrack = isSoundtrackAlbum(local);
  const primaryTitle = local.title.trim();
  const primaryArtist = local.artist.trim();

  if (soundtrack) {
    // Title-only first; the composer/game-name mismatch is common.
    push({ title: primaryTitle, artist: '' });
    for (const title of titles.slice(1, 3)) push({ title, artist: '' });
    for (const title of titles.slice(0, 2)) {
      for (const artist of artists.slice(0, 2)) push({ title, artist });
    }
  } else {
    // Exact old query first.
    push({ title: primaryTitle, artist: primaryArtist });
    for (const title of titles.slice(1, 6)) push({ title, artist: primaryArtist });
    for (const title of titles.slice(0, 2)) {
      for (const artist of artists.slice(1, 2)) push({ title, artist });
    }
    // Last resort: title only (localized artist namings, aliases). Full
    // scoring still weighs the artist, so this only helps when the release
    // title + durations are unambiguous.
    push({ title: titles[1] ?? titles[0] ?? primaryTitle, artist: '' });
  }

  return queries.slice(0, 6);
}

/**
 * Track-count-constrained queries, used when the plain searches did not turn
 * up an edition whose size matches. MusicBrainz's `tracks:` field pinpoints a
 * deluxe/anniversary edition that relevance ranking pushed out of the top hits.
 */
export function countQueries(local: LocalAlbumForMatch): ReleaseQuery[] {
  const count = local.tracks.length;
  if (count <= 0) return [];
  const titles = titleVariants(local);
  // Search the cleaned edition-stripped titles: "Homework (25th Anniversary
  // Edition) (1)" must become "homework" or `tracks:31` can never hit.
  const cleaned: string[] = [];
  for (const title of titles) {
    addUnique(cleaned, normalizeTitle(title));
    addUnique(cleaned, querySafe(normalizeTitle(title)));
  }
  const artists = artistVariants(local);
  const out: ReleaseQuery[] = [];
  const seen = new Set<string>();
  const push = (title: string, artist?: string): void => {
    const key = `${title.toLowerCase()}\u0000${(artist ?? '').toLowerCase()}`;
    if (!title.trim() || seen.has(key)) return;
    seen.add(key);
    out.push({ title, artist: artist ?? '', trackCount: count });
  };
  for (const title of cleaned.slice(0, 3)) {
    if (artists.length > 0) push(title, artists[0]);
    push(title);
  }
  return out.slice(0, 5);
}
