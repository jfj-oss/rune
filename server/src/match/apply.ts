// Applies a chosen MusicBrainz release to a local album: canonical album artist,
// release metadata, track/recording mapping, credits and genres.
import type { Db } from '../db/index.js';
import { ids } from '../db/index.js';
import {
  artistCreditName,
  flattenReleaseTracks,
  yearFromDate,
  type MbArtist,
  type MbArtistCredit,
  type MbGenre,
  type MbRelease,
  type MbTag,
  type MbTrack,
} from './mb.js';
import { collectCredits } from './credits.js';
import { titleCase, titleSimilarity } from './scoring.js';

export interface ApplyResult {
  albumId: string;
  mbReleaseId: string;
  mbReleaseGroupId?: string;
}

export interface LocalAlbumRow {
  id: string;
  source: string;
  title: string;
  artist_id: string;
  year: number | null;
  release_date: string | null;
  label: string | null;
  genres: string;
  format: string | null;
  folder_path: string | null;
  cover_path: string | null;
  mb_release_id: string | null;
  mb_release_group_id: string | null;
  match_confidence: number | null;
  match_locked: number;
  artist_name?: string | null;
}

export interface LocalTrackRow {
  id: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
  mb_recording_id: string | null;
}

export function getAlbumRow(db: Db, albumId: string): LocalAlbumRow | undefined {
  return db
    .prepare(
      `SELECT al.*, ar.name AS artist_name
         FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        WHERE al.id = ?`,
    )
    .get(albumId) as LocalAlbumRow | undefined;
}

export function getAlbumTracks(db: Db, albumId: string): LocalTrackRow[] {
  return db
    .prepare('SELECT id, title, disc, number, duration_ms, mb_recording_id FROM tracks WHERE album_id = ? ORDER BY disc, number')
    .all(albumId) as LocalTrackRow[];
}

/** Insert/update the canonical (MBID based) artist row. */
export function ensureArtistRow(db: Db, artist: MbArtist | { id: string; name: string; 'sort-name'?: string }): string {
  const artistId = ids.artistByMbid(artist.id);
  const sortName = artist['sort-name'] ?? null;
  db.prepare(
    `INSERT INTO artists (id, name, sort_name, mbid) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       mbid = excluded.mbid,
       sort_name = COALESCE(excluded.sort_name, artists.sort_name)`,
  ).run(artistId, artist.name, sortName, artist.id);
  return artistId;
}

/**
 * Repoint every reference from a provisional `ar:n:` artist to the canonical MBID
 * artist and delete the provisional row once it is unused. Conflict-safe for the
 * `(track_id, artist_id)` primary key of track_artists.
 */
export function repointArtist(db: Db, oldId: string, newId: string): void {
  if (oldId === newId) return;

  db.prepare('UPDATE albums SET artist_id = ? WHERE artist_id = ?').run(newId, oldId);
  db.prepare('UPDATE OR IGNORE track_artists SET artist_id = ? WHERE artist_id = ?').run(newId, oldId);
  db.prepare('DELETE FROM track_artists WHERE artist_id = ?').run(oldId);
  db.prepare('UPDATE credits SET artist_id = ? WHERE artist_id = ?').run(newId, oldId);

  // Remove the provisional artist only when nothing references it any more.
  db.prepare(
    `DELETE FROM artists
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM albums WHERE artist_id = ?)
        AND NOT EXISTS (SELECT 1 FROM track_artists WHERE artist_id = ?)
        AND NOT EXISTS (SELECT 1 FROM credits WHERE artist_id = ?)`,
  ).run(oldId, oldId, oldId, oldId);
}

/** Release-group genres + tags, merged and deduped, top 5, Title Case. */
export function extractGenres(release: MbRelease): string[] {
  const counts = new Map<string, { name: string; count: number; genre: boolean }>();

  const add = (entries: (MbGenre | MbTag)[] | undefined, genre: boolean): void => {
    for (const entry of entries ?? []) {
      const name = entry.name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const count = typeof entry.count === 'number' && entry.count > 0 ? entry.count : 1;
      const existing = counts.get(key);
      if (existing) {
        existing.count += count;
        existing.genre = existing.genre || genre;
      } else {
        counts.set(key, { name, count, genre });
      }
    }
  };

  const group = release['release-group'];
  add(group?.genres, true);
  add(group?.tags, false);
  // Fall back to release-level genres/tags when the group has none.
  if (counts.size === 0) {
    add(release.genres, true);
    add(release.tags, false);
  }

  return [...counts.values()]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (a.genre !== b.genre) return a.genre ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 5)
    .map((g) => titleCase(g.name));
}

function pickLabel(release: MbRelease): string | null {
  const names = (release['label-info'] ?? [])
    .map((info) => info.label?.name?.trim())
    .filter((name): name is string => Boolean(name));
  const unique = [...new Set(names)];
  return unique.length === 0 ? null : unique.join(', ');
}

/** MusicBrainz special-purpose artists ("[unknown]", "[anonymous]", "[no artist]", …) are
 *  placeholders, not people — never show them as track artists or credits. */
export const MB_PLACEHOLDER_ARTISTS = new Set([
  '125ec42a-7229-4250-afc5-e057484327fe', // [unknown]
  'f731ccc4-e22a-43af-a747-64213329e088', // [anonymous]
  '33cf029c-63b0-41a0-9855-be2a3665fb3b', // [no artist]
  '89ad4ac3-39f7-470e-963a-56509c546377', // Various Artists is handled elsewhere; kept for credits
]);
export function isPlaceholderArtist(id?: string, name?: string): boolean {
  return (!!id && MB_PLACEHOLDER_ARTISTS.has(id) && id !== '89ad4ac3-39f7-470e-963a-56509c546377') || (!!name && /^\[(unknown|anonymous|no artist|traditional)\]$/i.test(name.trim()));
}

function trackArtistCredit(track: MbTrack, release: MbRelease): MbArtistCredit[] {
  const real = (c: MbArtistCredit[] | undefined) => (c ?? []).filter((x) => !isPlaceholderArtist(x.artist?.id, x.artist?.name ?? x.name));
  const own = real(track['artist-credit']);
  if (own.length > 0) return own;
  const recordingCredit = real(track.recording?.['artist-credit']);
  if (recordingCredit.length > 0) return recordingCredit;
  return real(release['artist-credit']);
}

function replaceTrackArtists(db: Db, trackId: string, credit: MbArtistCredit[]): void {
  db.prepare('DELETE FROM track_artists WHERE track_id = ?').run(trackId);
  const insert = db.prepare('INSERT OR IGNORE INTO track_artists (track_id, artist_id, position) VALUES (?, ?, ?)');
  credit.forEach((entry, index) => {
    if (!entry.artist?.id) return;
    const artistId = ensureArtistRow(db, entry.artist);
    insert.run(trackId, artistId, index);
  });
}

/** Duration + title based fallback when disc/position does not line up. */
function fallbackTrack(
  local: LocalTrackRow,
  candidates: ReturnType<typeof flattenReleaseTracks>,
  used: Set<(typeof candidates)[number]>,
): (typeof candidates)[number] | undefined {
  let best: (typeof candidates)[number] | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (used.has(candidate)) continue;
    const titleScore = titleSimilarity(local.title, candidate.track.title);
    const length = candidate.track.length ?? candidate.recording?.length ?? null;
    const durationScore =
      length != null && length > 0 && local.duration_ms > 0
        ? Math.max(0, 1 - Math.abs(length - local.duration_ms) / 30000)
        : 0;
    const closeDuration = length != null && Math.abs(length - local.duration_ms) <= 3000;
    if (titleScore < 0.5 && !closeDuration) continue;
    const score = 0.65 * titleScore + 0.35 * durationScore;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 0.55 ? best : undefined;
}

/**
 * Apply a release to an album. Runs in a single transaction; cover download is
 * handled by the caller (network I/O must not hold a DB transaction).
 */
export function applyRelease(db: Db, albumId: string, release: MbRelease, confidence: number): ApplyResult {
  const apply = db.transaction((): ApplyResult => {
    const album = getAlbumRow(db, albumId);
    if (!album) throw new Error(`album not found: ${albumId}`);

    const localTracks = getAlbumTracks(db, albumId);
    const albumArtist = release['artist-credit']?.[0]?.artist;
    const oldArtistId = album.artist_id;

    // Canonical album artist (from the release artist credit).
    let canonicalArtistId = oldArtistId;
    if (albumArtist?.id) {
      canonicalArtistId = ensureArtistRow(db, albumArtist);
      if (oldArtistId.startsWith('ar:n:') && oldArtistId !== canonicalArtistId) {
        repointArtist(db, oldArtistId, canonicalArtistId);
      }
    }

    // Release-level metadata. The album title comes from MusicBrainz too: a
    // folder tagged "X" must become Chicago's "Chicago X". The scanner keeps
    // matcher-owned columns (title included) for matched albums when rescanning.
    const releaseDate = release.date ?? release['release-group']?.['first-release-date'] ?? album.release_date ?? null;
    const year = yearFromDate(releaseDate) ?? album.year;
    const label = pickLabel(release) ?? album.label;
    const genres = extractGenres(release);
    const releaseGroupId = release['release-group']?.id ?? null;
    const canonicalTitle = release.title?.trim() || album.title;

    db.prepare(
      `UPDATE albums
          SET title = ?,
              artist_id = ?,
              mb_release_id = ?,
              mb_release_group_id = ?,
              release_date = ?,
              year = ?,
              label = ?,
              genres = ?,
              match_confidence = ?
        WHERE id = ?`,
    ).run(
      canonicalTitle,
      canonicalArtistId,
      release.id,
      releaseGroupId,
      releaseDate,
      year,
      label,
      JSON.stringify(genres),
      confidence,
      albumId,
    );

    // Keep the search index in sync with the canonical title/artist (the
    // scanner skips matched albums, so it will not rebuild this row).
    try {
      const artistLabel = artistCreditName(release['artist-credit']) || album.artist_name || '';
      db.prepare("DELETE FROM search_fts WHERE kind = 'album' AND ref_id = ?").run(albumId);
      db.prepare("INSERT INTO search_fts (kind, ref_id, text) VALUES ('album', ?, ?)").run(
        albumId,
        `${canonicalTitle} ${artistLabel}`.trim(),
      );
    } catch {
      // FTS maintenance must never break matching.
    }

    // Track mapping by disc + position, falling back to duration + title.
    const flat = flattenReleaseTracks(release);
    const byPosition = new Map<string, (typeof flat)[number]>();
    for (const f of flat) byPosition.set(`${f.medium}:${f.position}`, f);

    const used = new Set<(typeof flat)[number]>();
    const localByRecording = new Map<string, string>();
    const updateRecording = db.prepare('UPDATE tracks SET mb_recording_id = ? WHERE id = ?');

    for (const local of localTracks) {
      let match = byPosition.get(`${local.disc}:${local.number}`);
      if (match && used.has(match)) match = undefined;
      if (!match) match = fallbackTrack(local, flat, used);
      if (!match) continue;
      used.add(match);

      const recordingId = match.recording?.id;
      if (recordingId) {
        updateRecording.run(recordingId, local.id);
        localByRecording.set(recordingId, local.id);
      }
      replaceTrackArtists(db, local.id, trackArtistCredit(match.track, release));
    }

    // Credits: release-level + recording-level + work relationships.
    db.prepare('DELETE FROM credits WHERE album_id = ?').run(albumId);
    const credits = collectCredits(
      release,
      localByRecording,
      localTracks.map((t) => t.id),
    );
    const insertCredit = db.prepare('INSERT INTO credits (album_id, artist_id, role, track_ids) VALUES (?, ?, ?, ?)');
    for (const credit of credits) {
      const artistId = ensureArtistRow(db, {
        id: credit.mbid,
        name: credit.name,
        'sort-name': credit.sortName,
      });
      insertCredit.run(albumId, artistId, credit.role, credit.trackIds ? JSON.stringify(credit.trackIds) : null);
    }

    return { albumId, mbReleaseId: release.id, mbReleaseGroupId: releaseGroupId ?? undefined };
  });

  return apply();
}
