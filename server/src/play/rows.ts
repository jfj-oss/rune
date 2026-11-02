// Map database rows to the shared Track / QueueItem shapes. Small and dependency-free
// so both the PC zone and the stream routes can share it.
import type { ArtistRef, QueueItem, Track } from '@liner/shared';
import type { Db } from '../db/index.js';

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

function trackArtists(db: Db, row: JoinedTrackRow): ArtistRef[] {
  const rows = db
    .prepare(
      `SELECT ar.id AS id, ar.name AS name
       FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
       WHERE ta.track_id = ? ORDER BY ta.position`,
    )
    .all(row.id) as { id: string; name: string }[];
  if (rows.length > 0) return rows.map((r) => ({ id: r.id, name: r.name }));
  if (row.album_artist_id && row.album_artist_name) {
    return [{ id: row.album_artist_id, name: row.album_artist_name }];
  }
  return [];
}

export function trackFromJoinedRow(db: Db, row: JoinedTrackRow): PlayableTrack {
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
    artists: trackArtists(db, row),
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

export function loadTrack(db: Db, id: string): Track | undefined {
  const row = db.prepare(`${SELECT_TRACK} WHERE t.id = ?`).get(id) as
    | JoinedTrackRow
    | undefined;
  return row ? trackFromJoinedRow(db, row) : undefined;
}

/** Load tracks preserving the requested id order; unknown ids are skipped. */
export function loadTracks(db: Db, ids: string[]): Track[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`${SELECT_TRACK} WHERE t.id IN (${placeholders})`)
    .all(...ids) as JoinedTrackRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Track[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(trackFromJoinedRow(db, row));
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

/** Load tracks and wrap them as QueueItems (album title/cover filled in where known). */
export function loadQueueItems(db: Db, ids: string[]): QueueItem[] {
  const tracks = loadTracks(db, ids);
  const albumRows = new Map<string, { title: string; cover_path: string | null }>();
  const stmt = db.prepare('SELECT title, cover_path FROM albums WHERE id = ?');
  return tracks.map((track) => {
    let album = albumRows.get(track.albumId);
    if (!album) {
      const row = stmt.get(track.albumId) as
        | { title: string; cover_path: string | null }
        | undefined;
      album = { title: row?.title ?? '', cover_path: row?.cover_path ?? null };
      albumRows.set(track.albumId, album);
    }
    return {
      queueId: makeQueueId(),
      track,
      album: {
        id: track.albumId,
        title: album.title,
        coverUrl: album.cover_path
          ? `/api/cover/${encodeURIComponent(track.albumId)}?size=200`
          : undefined,
      },
    };
  });
}
