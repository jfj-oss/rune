import type { Album, AlbumDetails, AlbumSummary, Artist, Page } from '@liner/shared';
import type { AlbumQuery, MatchCandidate, SearchResults, ZoneInfo } from '../lib/types';
import { registerTitles } from './covers';
import { ALBUMS, CANDIDATES, DETAILS, LOWCONF_ALBUM_ID, SUMMARIES, artistRefs, buildArtist, toSummary } from './data';

registerTitles(ALBUMS);

const wait = <T>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

export const MOCK_ZONES: ZoneInfo[] = [
  { id: 'pc', name: 'This PC (speakers)', kind: 'pc' },
  { id: 'browser', name: 'This browser', kind: 'browser' },
  { id: 'spotify:iphone', name: 'iPhone — Spotify', kind: 'spotify' },
];

export const mockApi = {
  async albums(q: AlbumQuery): Promise<Page<AlbumSummary>> {
    let list = SUMMARIES.slice();
    if (q.source && q.source !== 'all') list = list.filter((a) => a.source === q.source);
    if (q.q) {
      const s = q.q.toLowerCase();
      list = list.filter((a) => a.title.toLowerCase().includes(s) || a.artist.name.toLowerCase().includes(s));
    }
    if (q.year) list = list.filter((a) => a.year === q.year);
    if (q.genre) {
      const g = q.genre.toLowerCase();
      list = list.filter((a) => ALBUMS.find((x) => x.id === a.id)?.genres.some((x) => x.toLowerCase() === g));
    }
    if (q.label) {
      const l = q.label.toLowerCase();
      list = list.filter((a) => ALBUMS.find((x) => x.id === a.id)?.label?.toLowerCase() === l);
    }
    const sort = q.sort ?? 'added';
    list.sort((a, b) =>
      sort === 'added' ? b.addedAt - a.addedAt
      : sort === 'artist' ? a.artist.name.localeCompare(b.artist.name) || (a.year ?? 0) - (b.year ?? 0)
      : sort === 'title' ? a.title.localeCompare(b.title)
      : (b.year ?? 0) - (a.year ?? 0));
    const off = q.offset ?? 0;
    return wait({ items: list.slice(off, off + (q.limit ?? 60)), total: list.length });
  },
  async album(id: string): Promise<Album> {
    const a = ALBUMS.find((x) => x.id === id);
    if (!a) throw new Error('not found');
    return wait(a);
  },
  async details(id: string): Promise<AlbumDetails | null> {
    return wait(DETAILS[id] ?? null, DETAILS[id] ? 700 : 450);
  },
  async artist(id: string): Promise<Artist> {
    const a = buildArtist(id);
    if (!a) throw new Error('not found');
    return wait(a);
  },
  async search(q: string): Promise<SearchResults> {
    const s = q.trim().toLowerCase();
    if (!s) return { albums: [], artists: [], tracks: [] };
    const albums = SUMMARIES.filter((a) => a.title.toLowerCase().includes(s) || a.artist.name.toLowerCase().includes(s)).slice(0, 12);
    const artists = artistRefs.filter((a) => a.name.toLowerCase().includes(s)).slice(0, 8);
    const tracks = ALBUMS.flatMap((a) => a.tracks).filter((t) => t.title.toLowerCase().includes(s) || t.artists.some((x) => x.name.toLowerCase().includes(s))).slice(0, 8);
    return wait({ albums, artists, tracks }, 180);
  },
  async zones(): Promise<ZoneInfo[]> { return wait(MOCK_ZONES, 30); },
  async candidates(_id: string): Promise<MatchCandidate[]> { return wait(CANDIDATES, 250); },
  async match(albumId: string, _mb: string): Promise<void> {
    const a = ALBUMS.find((x) => x.id === albumId);
    if (a && albumId === LOWCONF_ALBUM_ID) { a.matchConfidence = 0.97; a.title = 'Rooms I Left'; }
    return wait(undefined, 400);
  },
};

export { ALBUMS, toSummary };
