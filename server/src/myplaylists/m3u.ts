// M3U8 export/import for rune playlists.
//
// Export: local tracks are written by absolute file path, Spotify tracks as
// `spotify:track:<id>` URIs. Import resolves paths against tracks.path (with a
// unique-basename fallback for moved files) and Spotify URIs against the local
// spotify catalogue — no network access is ever made.
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { PlayableTrack } from '../play/rows.js';

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function extinfTitle(track: Track): string {
  const artist = track.artists
    .map((a) => a.name)
    .filter(Boolean)
    .join(', ');
  return `${artist || 'Unknown Artist'} - ${track.title}`;
}

/** Spotify URI for a track (prefers the stored URI; falls back to its id). */
export function spotifyTrackUri(track: Track): string | undefined {
  if (track.source !== 'spotify') return undefined;
  if (track.spotifyUri) return track.spotifyUri;
  return `spotify:track:${track.id.startsWith('sp:') ? track.id.slice(3) : track.id}`;
}

/** Serialise ordered tracks as M3U8 text. Local tracks without a path are skipped. */
export function buildM3u8(name: string, tracks: (Track | PlayableTrack)[]): string {
  const out: string[] = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`];
  for (const track of tracks) {
    const location =
      track.source === 'spotify'
        ? spotifyTrackUri(track)
        : (track as PlayableTrack).path;
    if (!location) continue;
    const seconds = Math.max(0, Math.round(track.durationMs / 1000));
    out.push(`#EXTINF:${seconds},${oneLine(extinfTitle(track))}`);
    out.push(oneLine(location));
  }
  return out.join('\n') + '\n';
}

export interface ParsedM3u8 {
  name?: string;
  /** Non-comment lines in file order: paths or spotify URIs. */
  entries: string[];
}

export function parseM3u8(text: string): ParsedM3u8 {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const entries: string[] = [];
  let name: string | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#PLAYLIST:/i.test(trimmed)) {
      const parsed = trimmed.slice('#PLAYLIST:'.length).trim();
      if (parsed) name = parsed;
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    entries.push(trimmed);
  }
  return { entries, ...(name ? { name } : {}) };
}

/** `spotify:track:<id>` or an open.spotify.com track URL → local track id. */
export function spotifyIdFromEntry(entry: string): string | undefined {
  const s = entry.trim();
  const uri = /^spotify:track:([A-Za-z0-9]+)$/.exec(s);
  if (uri) return `sp:${uri[1]}`;
  const url = /^https?:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(s);
  if (url) return `sp:${url[1]}`;
  if (/^sp:[A-Za-z0-9]+$/.test(s)) return s;
  return undefined;
}

function trackExists(db: Db, id: string): boolean {
  return db.prepare('SELECT 1 FROM tracks WHERE id = ?').get(id) !== undefined;
}

const EXACT_PATH = `SELECT id FROM tracks WHERE path = ?
                    ORDER BY (cue_start_ms IS NULL), cue_start_ms, id LIMIT 1`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * Resolve one M3U8 entry to a track id, or undefined when it is not in the local
 * DB. Cue-sheet files resolve to their first cue track (paths alone cannot name a
 * cue index).
 */
export function resolveImportEntry(db: Db, entry: string): string | undefined {
  const spotifyId = spotifyIdFromEntry(entry);
  if (spotifyId) return trackExists(db, spotifyId) ? spotifyId : undefined;

  const raw = entry.trim();
  if (raw.startsWith('spotify:')) return undefined; // local/other Spotify URIs: not playable here
  let path = raw;
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path);
    } catch {
      /* keep the literal */
    }
  }

  const candidates = [path];
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) candidates.push(decoded);
  } catch {
    /* malformed escapes: try the literal path only */
  }
  for (const candidate of candidates) {
    const hit = db.prepare(EXACT_PATH).get(candidate) as { id: string } | undefined;
    if (hit) return hit.id;
  }

  // Fallback: a unique basename, for libraries moved between machines. Two files
  // with the same name in different folders are ambiguous and skipped.
  const base = basename(path.replace(/\\/g, '/'));
  if (!base) return undefined;
  const rows = db
    .prepare(
      `SELECT id, path FROM tracks WHERE path LIKE ? ESCAPE '\\'
       ORDER BY (cue_start_ms IS NULL), cue_start_ms, id`,
    )
    .all(`%/${escapeLike(base)}`) as { id: string; path: string | null }[];
  const paths = new Set(rows.map((r) => r.path ?? ''));
  if (paths.size !== 1) return undefined;
  return rows[0]?.id;
}

/** Safe `Content-Disposition` filename for a playlist name. */
export function m3u8Filename(name: string): string {
  const safe = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${safe || 'playlist'}.m3u8`;
}
