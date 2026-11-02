// Station logo cache: downloads a station favicon once into
// <dataDir>/radio-logos and remembers the file + real MIME type in the DB.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { getStationRow, saveLogo } from './store.js';
import { stationUuid, type RadioStation } from './types.js';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 15_000;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export interface CachedLogo {
  path: string;
  mime: string;
}

/**
 * Return the cached logo file for a station, downloading the favicon first if
 * necessary. Never throws: a missing/broken favicon just yields undefined.
 */
export async function cacheStationLogo(
  db: Db,
  cfg: Config,
  station: RadioStation,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CachedLogo | undefined> {
  const row = getStationRow(db, station.id);
  if (!row) return undefined;
  if (row.logo_path && row.logo_mime && existsSync(row.logo_path)) {
    return { path: row.logo_path, mime: row.logo_mime };
  }
  const favicon = normalizeFavicon(row.favicon);
  if (!favicon) return undefined;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOGO_TIMEOUT_MS);
    timer.unref?.();
    let res: Response;
    try {
      res = await fetchImpl(favicon, {
        headers: { 'User-Agent': cfg.userAgent, Accept: 'image/*,*/*;q=0.5' },
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return undefined;
    const contentLength = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_LOGO_BYTES) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return undefined;

    const declared = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    const sniffed = sniffImageMime(bytes);
    const mime = declared.startsWith('image/') ? declared : sniffed;
    if (!mime) return undefined;
    const ext = MIME_EXT[mime] ?? (extname(new URL(favicon).pathname).slice(1).toLowerCase() || 'img');

    const dir = join(cfg.dataDir, 'radio-logos');
    mkdirSync(dir, { recursive: true });
    const uuid = stationUuid(station.id);
    const safe = uuid.replace(/[^a-z0-9-]/gi, '_');
    const hash = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
    const out = join(dir, `${safe}-${hash}.${ext}`);
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, out);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
      return undefined;
    }
    // Drop an older cached variant for the same station.
    if (row.logo_path && row.logo_path !== out && existsSync(row.logo_path)) {
      try {
        unlinkSync(row.logo_path);
      } catch {
        // best effort
      }
    }
    saveLogo(db, station.id, out, mime);
    return { path: out, mime };
  } catch {
    return undefined;
  }
}

/** Cached logo without touching the network (used by the logo route). */
export function cachedLogo(db: Db, id: string): CachedLogo | undefined {
  const row = getStationRow(db, id);
  if (!row?.logo_path || !row.logo_mime) return undefined;
  return existsSync(row.logo_path) ? { path: row.logo_path, mime: row.logo_mime } : undefined;
}

export function normalizeFavicon(favicon: string | null | undefined): string | undefined {
  if (!favicon) return undefined;
  let url = favicon.trim();
  if (!url) return undefined;
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}
