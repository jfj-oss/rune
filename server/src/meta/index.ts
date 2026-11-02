// Worker D — phase 2 album metadata: critical reception, critic scores, review
// quotes, background prose, and artist notes, merged into AlbumDetails and
// cached in the `album_details` table.
//
// Public contract (modules.ts has no Meta interface yet):
//   createMeta(db, cfg, deps?) -> MetaService { getDetails, fetchDetails, invalidate }
//   registerMetaRoutes(app, meta) adds GET /albums/:id/details
import type { FastifyInstance } from 'fastify';
import type { AlbumDetails, CriticQuote, CriticScore } from '@liner/shared';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { CachedHttp, type HttpDeps } from './http.js';
import { fetchWikipedia } from './wikipedia.js';
import { fetchMetacritic, type ReviewAlbumRef } from './metacritic.js';
import { fetchAoty } from './albumoftheyear.js';
import { fetchPitchfork, pickPitchforkReferenceUrl } from './pitchfork.js';
import { fetchGenius, type GeniusNote, type TrackRef } from './genius.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetaDeps extends HttpDeps {
  /** How long non-empty details stay fresh. Default 30 days. */
  ttlMs?: number;
  /** How long "nothing found" results stay fresh. Default 7 days. */
  emptyTtlMs?: number;
  geniusMaxTracks?: number;
  geniusMaxNotes?: number;
}

export interface MetaService {
  /**
   * AlbumDetails for an album, from `album_details` when fresh, otherwise
   * fetched from the sources. Returns null only when the album row is unknown.
   */
  getDetails(albumId: string, opts?: { refresh?: boolean }): Promise<AlbumDetails | null>;
  /** Always re-fetch (still uses the HTTP cache), then store. */
  fetchDetails(albumId: string): Promise<AlbumDetails | null>;
  /** Drop the stored details (next getDetails re-fetches). */
  invalidate(albumId: string): void;
}

export type CreateMeta = (db: Db, cfg: Config, deps?: MetaDeps) => MetaService;

interface AlbumRow {
  id: string;
  title: string;
  year: number | null;
  release_date: string | null;
  source: string;
  mb_release_id: string | null;
  folder_path: string | null;
  artist_name: string | null;
}

interface StoredDetails {
  json: string;
  fetched_at: number;
}

const OUTLET_ORDER = ['Metacritic', 'Album of the Year', 'Pitchfork'];

function mergeScores(wikipediaScores: CriticScore[], direct: (CriticScore | undefined)[]): CriticScore[] {
  const byOutlet = new Map<string, CriticScore>();
  for (const score of wikipediaScores) byOutlet.set(score.outlet, score);
  for (const score of direct) if (score) byOutlet.set(score.outlet, score);
  return [...byOutlet.values()].sort((a, b) => {
    const ai = OUTLET_ORDER.indexOf(a.outlet);
    const bi = OUTLET_ORDER.indexOf(b.outlet);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function mergeQuotes(quotes: (CriticQuote | undefined)[]): CriticQuote[] {
  const out: CriticQuote[] = [];
  for (const q of quotes) {
    if (!q || !q.quote) continue;
    if (out.some((existing) => existing.outlet === q.outlet && existing.quote === q.quote)) continue;
    out.push(q);
  }
  return out;
}

function isEmptyDetails(d: AlbumDetails): boolean {
  return !d.reception && !d.background && d.scores.length === 0 && d.quotes.length === 0 && d.artistNotes.length === 0;
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export function createMeta(db: Db, cfg: Config, deps: MetaDeps = {}): MetaService {
  const http = new CachedHttp(db, cfg, deps);
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? 30 * DAY_MS;
  const emptyTtlMs = deps.emptyTtlMs ?? 7 * DAY_MS;
  const inflight = new Map<string, Promise<AlbumDetails | null>>();

  const albumStmt = db.prepare(
    `SELECT a.id, a.title, a.year, a.release_date, a.source, a.mb_release_id, a.folder_path,
            ar.name AS artist_name
       FROM albums a
       LEFT JOIN artists ar ON ar.id = a.artist_id
      WHERE a.id = ?`,
  );
  const tracksStmt = db.prepare('SELECT id, title FROM tracks WHERE album_id = ? ORDER BY disc, number');
  const readStmt = db.prepare('SELECT json, fetched_at FROM album_details WHERE album_id = ?');
  const writeStmt = db.prepare(
    `INSERT INTO album_details (album_id, json, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
  );
  const deleteStmt = db.prepare('DELETE FROM album_details WHERE album_id = ?');

  function albumRow(albumId: string): AlbumRow | null {
    return (albumStmt.get(albumId) as AlbumRow | undefined) ?? null;
  }

  function readStored(albumId: string): StoredDetails | null {
    return (readStmt.get(albumId) as StoredDetails | undefined) ?? null;
  }

  function store(details: AlbumDetails): void {
    writeStmt.run(details.albumId, JSON.stringify(details), details.fetchedAt);
  }

  async function fetchFresh(albumId: string): Promise<AlbumDetails | null> {
    const row = albumRow(albumId);
    if (!row) return null;

    const album: ReviewAlbumRef = {
      id: row.id,
      title: row.title,
      artist: row.artist_name ?? 'Various Artists',
      ...(row.year == null ? {} : { year: row.year }),
    };
    const tracks = tracksStmt.all(albumId) as TrackRef[];

    // Wikipedia first: the ratings table often carries the only accessible
    // Metacritic/AOTY score, and its Pitchfork citation gives us a direct URL.
    const wiki = await safe(fetchWikipedia(http, album));
    const pitchforkKnownUrl =
      wiki?.scores.find((s) => s.outlet === 'Pitchfork')?.url ??
      (wiki ? pickPitchforkReferenceUrl(wiki.referenceUrls, album.title) : undefined);

    const [metacritic, aoty, pitchfork, genius] = await Promise.all([
      safe(fetchMetacritic(http, album)),
      safe(fetchAoty(http, album)),
      safe(fetchPitchfork(http, album, pitchforkKnownUrl)),
      safe(
        fetchGenius(http, album, tracks, {
          ...(deps.geniusMaxTracks == null ? {} : { maxTracks: deps.geniusMaxTracks }),
          ...(deps.geniusMaxNotes == null ? {} : { maxNotes: deps.geniusMaxNotes }),
        }),
      ),
    ]);

    const scores = mergeScores(wiki?.scores ?? [], [metacritic?.score, aoty?.score, pitchfork?.score]);
    const quotes = mergeQuotes([pitchfork?.quote]);
    const artistNotes: GeniusNote[] = genius ?? [];

    return {
      albumId: row.id,
      ...(wiki?.reception ? { reception: wiki.reception } : {}),
      scores,
      quotes,
      ...(wiki?.background ? { background: wiki.background } : {}),
      artistNotes,
      fetchedAt: now(),
    };
  }

  function fetchWithDedupe(albumId: string): Promise<AlbumDetails | null> {
    const existing = inflight.get(albumId);
    if (existing) return existing;
    const promise = fetchFresh(albumId)
      .then((details) => {
        if (details) store(details);
        return details;
      })
      .finally(() => {
        inflight.delete(albumId);
      });
    inflight.set(albumId, promise);
    return promise;
  }

  return {
    async getDetails(albumId, opts = {}) {
      if (!albumRow(albumId)) return null;
      if (!opts.refresh) {
        const stored = readStored(albumId);
        if (stored) {
          try {
            const details = JSON.parse(stored.json) as AlbumDetails;
            const ttl = isEmptyDetails(details) ? emptyTtlMs : ttlMs;
            if (now() - stored.fetched_at < ttl) return details;
          } catch {
            // Corrupt JSON: fall through and refetch.
          }
        }
      }
      return fetchWithDedupe(albumId);
    },

    fetchDetails(albumId) {
      if (!albumRow(albumId)) return Promise.resolve(null);
      return fetchWithDedupe(albumId);
    },

    invalidate(albumId) {
      deleteStmt.run(albumId);
    },
  };
}

/** Wire the phase-2 details route. The API prefix (`/api`) is added by the app. */
export function registerMetaRoutes(app: FastifyInstance, meta: MetaService): void {
  app.get('/albums/:id/details', async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return reply.code(400).send({ error: 'missing album id' });
    const refresh = (request.query as { refresh?: string } | undefined)?.refresh;
    const details = await meta.getDetails(id, { refresh: refresh === '1' || refresh === 'true' });
    if (!details) return reply.code(404).send({ error: 'album not found' });
    return details;
  });
}
