// GET /health — one JSON document the UI / a watchdog can poll.
//
// Everything is injected: the main session passes whatever modules exist (the
// watcher's status(), the scanner's last-run time, mpv's pid, Spotify auth, job
// flags). Missing callbacks fall back to neutral values so the endpoint keeps
// working while a module is disabled (RUNE_NO_PC, no Spotify client id, ...).
//
// Shape:
//   { ok, version, uptimeS,
//     db: { albums, tracks, sizeMB },
//     library: { roots: [{ path, mounted, readOnly, free }], lastScanAt },
//     mpv: { pid?, alive },
//     spotify: { connected },
//     jobs: { matching, details, loudness? } }
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { rootsStatus, type LibraryRootStatus } from '../watch/root-status.js';

export type MaybeAsync<T> = T | Promise<T>;
/** A static value or a function producing it (possibly async). */
export type ValueOrGetter<T> = MaybeAsync<T> | (() => MaybeAsync<T>);

export interface DbHealth {
  albums: number;
  tracks: number;
  /** Logical database size (page_count * page_size), in MiB. */
  sizeMB: number;
}

export interface LibraryHealth {
  roots: LibraryRootStatus[];
  /** Epoch ms of the last completed scan, or null when unknown. */
  lastScanAt: number | null;
}

export interface MpvHealth {
  pid?: number;
  alive: boolean;
}

export interface SpotifyHealth {
  connected: boolean;
}

export interface JobsHealth {
  matching: boolean;
  details: boolean;
  loudness?: boolean;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeS: number;
  db: DbHealth;
  library: LibraryHealth;
  mpv: MpvHealth;
  spotify: SpotifyHealth;
  jobs: JobsHealth;
}

export interface HealthDeps {
  version: string;
  /** Epoch ms the server started; defaults to registration time. */
  startedAt?: number;
  /** Used when dbStats is not supplied. */
  db?: Db;
  dbStats?: () => MaybeAsync<DbHealth>;
  /** Full library block from the caller (e.g. watcher.status() + scanner time). */
  library?: ValueOrGetter<LibraryHealth>;
  /** Convenience when only the roots are known: computes mount/readOnly/free. */
  libraryRoots?: readonly string[];
  lastScanAt?: ValueOrGetter<number | null | undefined>;
  mpv?: ValueOrGetter<MpvHealth>;
  spotify?: ValueOrGetter<SpotifyHealth>;
  jobs?: ValueOrGetter<JobsHealth>;
  now?: () => number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

const EMPTY_DB: DbHealth = { albums: 0, tracks: 0, sizeMB: 0 };

/** Physical/logical stats for the live database. Throws if the DB is unreadable. */
export function readDbHealth(db: Db): DbHealth {
  const count = (table: string): number => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  };
  const pages = Number(db.pragma('page_count', { simple: true }) ?? 0);
  const pageSize = Number(db.pragma('page_size', { simple: true }) ?? 0);
  const bytes = pages * pageSize;
  return {
    albums: count('albums'),
    tracks: count('tracks'),
    sizeMB: Math.round((bytes / (1024 * 1024)) * 100) / 100,
  };
}

async function resolveValue<T>(value: ValueOrGetter<T> | undefined, fallback: T): Promise<T> {
  if (value === undefined) return fallback;
  const resolved = typeof value === 'function' ? await (value as () => MaybeAsync<T>)() : await value;
  return resolved ?? fallback;
}

/** Build the health document. Never throws: errors are reported as ok:false + logs. */
export async function collectHealth(deps: HealthDeps): Promise<HealthResponse> {
  const now = deps.now ?? Date.now;
  const startedAt = deps.startedAt ?? now();
  let ok = true;

  let db: DbHealth = EMPTY_DB;
  try {
    if (deps.dbStats) db = await deps.dbStats();
    else if (deps.db) db = readDbHealth(deps.db);
  } catch (err) {
    ok = false;
    try {
      deps.logger?.warn({ err }, 'health: database stats failed');
    } catch {
      // ignore
    }
  }

  let library: LibraryHealth = { roots: [], lastScanAt: null };
  if (deps.library !== undefined) {
    library = await resolveValue<LibraryHealth>(deps.library, library);
  } else {
    const roots = deps.libraryRoots ? rootsStatus(deps.libraryRoots) : [];
    const lastScanAt = (await resolveValue<number | null | undefined>(deps.lastScanAt, null)) ?? null;
    library = { roots, lastScanAt };
  }

  const mpvValue = await resolveValue<MpvHealth>(deps.mpv, { alive: false });
  const mpv: MpvHealth = {
    ...(typeof mpvValue.pid === 'number' ? { pid: mpvValue.pid } : {}),
    alive: mpvValue.alive === true,
  };

  const spotify = (await resolveValue<SpotifyHealth>(deps.spotify, { connected: false })) ?? { connected: false };
  const jobsValue = await resolveValue<JobsHealth>(deps.jobs, { matching: false, details: false });
  const jobs: JobsHealth = {
    matching: jobsValue.matching === true,
    details: jobsValue.details === true,
    ...(typeof jobsValue.loudness === 'boolean' ? { loudness: jobsValue.loudness } : {}),
  };

  const uptimeS = Math.max(0, Math.floor((now() - startedAt) / 1000));

  return {
    ok,
    version: deps.version,
    uptimeS,
    db,
    library: {
      roots: library.roots ?? [],
      lastScanAt: library.lastScanAt ?? null,
    },
    mpv,
    spotify: { connected: spotify.connected === true },
    jobs,
  };
}

/** GET /health. Registered without the /api prefix on purpose. */
export function registerOpsRoutes(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => collectHealth(deps));
}
