// Mock data for the Tracks / Genres / history / frame-check screens (?mock=1).
import type { AlbumSummary, Page, RecentAlbum, RediscoverAlbum } from '@liner/shared';
import type { BrowseTrack, GenreAlbumQuery, GenreFacet, LabelFacet, TrackQuery, YearFacet } from '../lib/types';
import { ALBUMS, toSummary } from './data';

const wait = <T>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const DAY = 86_400_000;

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

const ALL_TRACKS: (BrowseTrack & { _added: number })[] = ALBUMS.filter((a) => a.source === 'local').flatMap((a) =>
  a.tracks.map((t) => ({ ...t, album: { id: a.id, title: a.title, coverUrl: a.coverUrl }, _added: a.addedAt })),
);

export const mockBrowse = {
  async tracks(q: TrackQuery): Promise<Page<BrowseTrack>> {
    let list = ALL_TRACKS.slice();
    const s = q.q?.trim().toLowerCase();
    if (s) list = list.filter((t) => t.title.toLowerCase().includes(s) || t.album.title.toLowerCase().includes(s) || t.artists.some((a) => a.name.toLowerCase().includes(s)));
    const sort = q.sort ?? 'title';
    const dir = (q.dir ?? (sort === 'added' ? 'desc' : 'asc')) === 'desc' ? -1 : 1;
    const key = (t: (typeof list)[number]) =>
      sort === 'artist' ? (t.artists[0]?.name ?? '').toLowerCase()
      : sort === 'album' ? t.album.title.toLowerCase()
      : sort === 'duration' ? t.durationMs
      : sort === 'added' ? t._added
      : t.title.toLowerCase();
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.disc - b.disc || a.number - b.number;
    });
    const off = q.offset ?? 0;
    const items = list.slice(off, off + (q.limit ?? 100)).map(({ _added: _a, ...t }) => t);
    return wait({ items, total: list.length });
  },

  async genres(): Promise<GenreFacet[]> {
    const map = new Map<string, { albums: typeof ALBUMS }>();
    for (const a of ALBUMS) for (const g of a.genres) {
      const k = g.toLowerCase();
      (map.get(k) ?? map.set(k, { albums: [] }).get(k)!).albums.push(a);
    }
    const out = [...map.entries()].map(([k, v]) => ({
      genre: titleCase(k),
      albumCount: v.albums.length,
      coverAlbumIds: v.albums.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 4).map((a) => a.id),
    }));
    out.sort((a, b) => b.albumCount - a.albumCount || a.genre.localeCompare(b.genre));
    return wait(out);
  },

  async genreAlbums(genre: string, q: GenreAlbumQuery): Promise<Page<AlbumSummary>> {
    const g = genre.trim().toLowerCase();
    const list = ALBUMS.filter((a) => a.genres.some((x) => x.toLowerCase() === g)).map(toSummary);
    const sort = q.sort ?? 'artist';
    const dir = (q.dir ?? (sort === 'added' ? 'desc' : 'asc')) === 'desc' ? -1 : 1;
    list.sort((a, b) =>
      dir * (sort === 'added' ? a.addedAt - b.addedAt
        : sort === 'title' ? a.title.localeCompare(b.title)
        : sort === 'year' ? (a.year ?? 0) - (b.year ?? 0)
        : a.artist.name.localeCompare(b.artist.name) || (a.year ?? 0) - (b.year ?? 0)));
    const off = q.offset ?? 0;
    return wait({ items: list.slice(off, off + (q.limit ?? 100)), total: list.length });
  },

  async labels(): Promise<LabelFacet[]> {
    const m = new Map<string, number>();
    for (const a of ALBUMS) if (a.label) m.set(a.label, (m.get(a.label) ?? 0) + 1);
    return wait([...m.entries()].map(([label, albumCount]) => ({ label, albumCount })).sort((a, b) => b.albumCount - a.albumCount || a.label.localeCompare(b.label)), 60);
  },

  async years(): Promise<YearFacet[]> {
    const m = new Map<number, number>();
    for (const a of ALBUMS) if (a.year) m.set(a.year, (m.get(a.year) ?? 0) + 1);
    return wait([...m.entries()].map(([year, albumCount]) => ({ year, albumCount, decade: Math.floor(year / 10) * 10 })).sort((a, b) => b.year - a.year), 60);
  },

  async historyRecent(limit: number): Promise<RecentAlbum[]> {
    const picks = [1, 3, 6, 14, 19, 21, 25, 8, 11];
    const now = Date.now();
    return wait(picks.map((i, n) => ({ albumId: (ALBUMS[i] ?? ALBUMS[0]!).id, lastPlayedAt: now - (n + 1) * 7 * 3_600_000, plays: 9 - n })).slice(0, limit), 90);
  },

  async historyRediscover(limit: number): Promise<RediscoverAlbum[]> {
    const recent = new Set([1, 3, 6, 14, 19, 21, 25, 8, 11].map((i) => ALBUMS[i]?.id));
    const pool = ALBUMS.filter((a) => a.source === 'local' && !recent.has(a.id));
    return wait(pool.filter((_, i) => i % 2 === 0).slice(0, limit).map((a, n) => ({ albumId: a.id, lastPlayedAt: n % 3 === 0 ? null : Date.now() - (120 + n * 40) * DAY, plays: n % 3 === 0 ? 0 : n })), 110);
  },

  /** Mock rule: example.org (and Wikipedia) may be framed; everything else blocks it, like Pitchfork or Genius. */
  async frameOk(url: string): Promise<boolean> {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* bad url */ }
    return wait(host === 'example.org' || host.endsWith('wikipedia.org'), 500);
  },
};
