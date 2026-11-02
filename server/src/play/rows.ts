// Map database rows to the shared Track / QueueItem shapes. Small and dependency-free
// so both the PC zone and the stream routes can share it.
import type { ArtistRef, QueueItem, Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import { radioQueueAlbum, radioTrackForStation } from '../iradio/store.js';
import { coverUrlFor } from '../api/cover.js';

const RADIO_ID_PREFIX = 'rs:';

/** The shared Track plus the local file path (a field the shared contract lacks). */
export interface PlayableTrack extends Track {
  path?: string;
}

/** File path for a local track, if one exists. */
export function trackPath(track: Track): string | undefined {
  return (track as PlayableTrack).path;
}

export interface TrackRow {
  id: string;
  album_id: string;
  source: string;
  title: string;
  disc: number;
  number: number;
  duration_ms: number;
  path: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  bitrate_kbps: number | null;
  spotify_uri: string | null;
}

interface JoinedTrackRow extends TrackRow {
  album_title: string | null;
  cover_path: string | null;
  album_artist_id: string | null;
  album_artist_name: string | null;
}

const SELECT_TRACK = `
  SELECT t.id, t.album_id, t.source, t.title, t.disc, t.number, t.duration_ms,
         t.path, t.cue_start_ms, t.cue_end_ms, t.format, t.sample_rate, t.bit_depth,
         t.bitrate_kbps, t.spotify_uri,
         a.title AS album_title, a.cover_path,
         a.artist_id AS album_artist_id, ar.name AS album_artist_name
  FROM tracks t
  JOIN albums a ON a.id = t.album_id
  LEFT JOIN artists ar ON ar.id = a.artist_id
`;

export function loadTrackRow(db: Db, id: string): TrackRow | undefined {
  return db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
}

function mapFormat(format: string | null): Track['format'] {
  const f = (format ?? '').toLowerCase();
  if (f.includes('flac')) return 'flac';
  if (f.includes('mp3')) return 'mp3';
  if (f.length > 0) return 'other';
  return undefined;
}

/** Keep every SQL IN (...) list below SQLite's conservative variable bound. */
const MAX_IN_CHUNK = 500;

function chunk<T>(items: T[], size = MAX_IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/**
 * Explicit track artists for many tracks at once (one IN (...) query per chunk).
 * Missing entries fall back to the album artist in `artistsFor` below.
 */
export function loadTrackArtists(db: Db, trackIds: string[]): Map<string, ArtistRef[]> {
  const out = new Map<string, ArtistRef[]>();
  const unique = [...new Set(trackIds)];
  for (const part of chunk(unique)) {
    if (part.length === 0) continue;
    const rows = db
      .prepare(
        `SELECT ta.track_id AS track_id, ar.id AS id, ar.name AS name
         FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
         WHERE ta.track_id IN (${placeholders(part.length)})
         ORDER BY ta.track_id, ta.position`,
      )
      .all(...part) as { track_id: string; id: string; name: string }[];
    for (const row of rows) {
      const list = out.get(row.track_id);
      const artist = { id: row.id, name: row.name };
      if (list) list.push(artist);
      else out.set(row.track_id, [artist]);
    }
  }
  return out;
}

function trackArtists(db: Db, row: JoinedTrackRow): ArtistRef[] {
  const rows = db
    .prepare(
      `SELECT ar.id AS id, ar.name AS name
       FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
       WHERE ta.track_id = ? ORDER BY ta.position`,
    )
    .all(row.id) as { id: string; name: string }[];
  const explicit = rows.map((r) => ({ id: r.id, name: r.name }));
  return explicit.length > 0 ? explicit : artistsFromAlbum(row);
}

function artistsFromAlbum(row: JoinedTrackRow): ArtistRef[] {
  if (row.album_artist_id && row.album_artist_name) {
    return [{ id: row.album_artist_id, name: row.album_artist_name }];
  }
  return [];
}

function trackFromRow(row: JoinedTrackRow, explicitArtists?: ArtistRef[]): PlayableTrack {
  const durationMs = row.duration_ms;
  let cue: Track['cue'];
  if (row.cue_start_ms != null) {
    const startMs = row.cue_start_ms;
    const endMs = row.cue_end_ms ?? startMs + durationMs;
    cue = { startMs, endMs };
  }
  return {
    id: row.id,
    albumId: row.album_id,
    source: row.source === 'spotify' ? 'spotify' : 'local',
    title: row.title,
    artists:
      explicitArtists && explicitArtists.length > 0 ? explicitArtists : artistsFromAlbum(row),
    disc: row.disc,
    number: row.number,
    durationMs: cue ? Math.max(0, cue.endMs - cue.startMs) : durationMs,
    format: mapFormat(row.format),
    sampleRate: row.sample_rate ?? undefined,
    bitDepth: row.bit_depth ?? undefined,
    bitrateKbps: row.bitrate_kbps ?? undefined,
    cue,
    spotifyUri: row.spotify_uri ?? undefined,
    path: row.path ?? undefined,
  };
}

export function trackFromJoinedRow(db: Db, row: JoinedTrackRow): PlayableTrack {
  return trackFromRow(row, trackArtists(db, row));
}

export function loadTrack(db: Db, id: string): Track | undefined {
  if (id.startsWith(RADIO_ID_PREFIX)) return radioTrackForStation(db, id)?.track;
  const row = db.prepare(`${SELECT_TRACK} WHERE t.id = ?`).get(id) as
    | JoinedTrackRow
    | undefined;
  return row ? trackFromJoinedRow(db, row) : undefined;
}

/** Load tracks preserving the requested id order; unknown ids are skipped. */
export function loadTracks(db: Db, ids: string[]): Track[] {
  if (ids.length === 0) return [];
  // Deduplicate for the IN (...) queries (a playlist may repeat a song) but walk
  // the caller's ids below, so duplicates keep their requested order.
  const unique = [...new Set(ids)];
  const rows: JoinedTrackRow[] = [];
  for (const part of chunk(unique)) {
    rows.push(
      ...(db
        .prepare(`${SELECT_TRACK} WHERE t.id IN (${placeholders(part.length)})`)
        .all(...part) as JoinedTrackRow[]),
    );
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const artists = loadTrackArtists(db, unique);
  const out: Track[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(trackFromRow(row, artists.get(id)));
  }
  return out;
}

let queueSeq = 0;

/** Unique queue-entry id (a track can appear more than once in a queue). */
export function makeQueueId(): string {
  queueSeq += 1;
  return `q:${Date.now().toString(36)}-${queueSeq.toString(36)}`;
}

export function makeQueueItem(track: Track, queueId = makeQueueId()): QueueItem {
  const album: QueueItem['album'] = {
    id: track.albumId,
    title: '',
  };
  return { queueId, track, album };
}

/**
 * Load tracks and wrap them as QueueItems (album title/cover filled in where
 * known). Radio stations ('rs:<uuid>') come from radio_stations instead of the
 * local tracks table and keep their requested position in the queue.
 */
export function loadQueueItems(db: Db, ids: string[]): QueueItem[] {
  const localIds = ids.filter((id) => !id.startsWith(RADIO_ID_PREFIX));
  const localTracks = new Map(loadTracks(db, localIds).map((track) => [track.id, track]));
  const albumRows = new Map<string, { title: string; cover_path: string | null }>();
  const stmt = db.prepare('SELECT title, cover_path FROM albums WHERE id = ?');
  const items: QueueItem[] = [];
  for (const id of ids) {
    if (id.startsWith(RADIO_ID_PREFIX)) {
      const radio = radioTrackForStation(db, id);
      if (!radio) continue;
      items.push({ queueId: makeQueueId(), track: radio.track, album: radioQueueAlbum(radio.station) });
      continue;
    }
    const track = localTracks.get(id);
    if (!track) continue;
    let album = albumRows.get(track.albumId);
    if (!album) {
      const row = stmt.get(track.albumId) as
        | { title: string; cover_path: string | null }
        | undefined;
      album = { title: row?.title ?? '', cover_path: row?.cover_path ?? null };
      albumRows.set(track.albumId, album);
    }
    items.push({
      queueId: makeQueueId(),
      track,
      album: {
        id: track.albumId,
        title: album.title,
        coverUrl: coverUrlFor(track.albumId, album.cover_path, 200),
      },
    });
  }
  return items;
}
