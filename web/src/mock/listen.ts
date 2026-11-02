// Mock fixtures for the listen features: internet-radio stations, rune radio picks,
// generated waveform peaks and the two settings toggles. Everything is in-memory.
import type { Album, Track } from '@liner/shared';
import { hashString } from '../lib/color';
import type { NormalizeMode, PeaksResult, RadioFrom, RadioPick, RadioSearchParams, RadioSearchResult, RadioStartResult, RadioStation } from '../lib/listenTypes';
import { ALBUMS } from './data';
import { mockCover } from './covers';
import { rng } from './data';

const wait = <T>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

type BaseStation = Omit<RadioStation, 'id' | 'stationuuid' | 'logoUrl' | 'favourite'>;

const SEEDS: BaseStation[] = [
  { name: 'Northlight Jazz', url: 'https://radio.example/northlight-jazz', tags: ['jazz', 'smooth'], country: 'Norway', countrycode: 'NO', language: 'English', codec: 'MP3', bitrate: 192, votes: 12_840, clickcount: 5_300, clicktrend: 22, hls: false, lastCheckOk: true },
  { name: 'Cellar Door Radio', url: 'https://radio.example/cellar-door', tags: ['jazz', 'piano'], country: 'Czechia', countrycode: 'CZ', language: 'Czech', codec: 'AAC', bitrate: 128, votes: 9_120, clickcount: 3_100, clicktrend: 8, hls: false, lastCheckOk: true },
  { name: 'Slow Light Ambient', url: 'https://radio.example/slow-light', tags: ['ambient', 'drone'], country: 'Iceland', countrycode: 'IS', language: 'English', codec: 'MP3', bitrate: 256, votes: 8_470, clickcount: 2_900, clicktrend: -3, hls: false, lastCheckOk: true },
  { name: 'Fjord Drift', url: 'https://radio.example/fjord-drift', tags: ['ambient', 'electronic'], country: 'Norway', countrycode: 'NO', language: 'Norwegian', codec: 'AAC', bitrate: 160, votes: 6_210, clickcount: 1_740, clicktrend: 41, hls: false, lastCheckOk: true },
  { name: 'Sostenuto Classical', url: 'https://radio.example/sostenuto', tags: ['classical', 'chamber'], country: 'Germany', countrycode: 'DE', language: 'German', codec: 'MP3', bitrate: 320, votes: 11_030, clickcount: 4_500, clicktrend: 12, hls: false, lastCheckOk: true },
  { name: 'Late Quartet', url: 'https://radio.example/late-quartet', tags: ['classical', 'strings'], country: 'Austria', countrycode: 'AT', language: 'German', codec: 'AAC', bitrate: 192, votes: 4_980, clickcount: 1_200, clicktrend: 4, hls: false, lastCheckOk: true },
  { name: 'Grid Lines FM', url: 'https://radio.example/grid-lines', tags: ['electronic', 'idm'], country: 'United Kingdom', countrycode: 'GB', language: 'English', codec: 'MP3', bitrate: 192, votes: 10_450, clickcount: 3_880, clicktrend: 19, hls: false, lastCheckOk: true },
  { name: 'Night Bus', url: 'https://radio.example/night-bus', tags: ['electronic', 'techno'], country: 'Netherlands', countrycode: 'NL', language: 'English', codec: 'AAC', bitrate: 256, votes: 7_660, clickcount: 2_210, clicktrend: 7, hls: false, lastCheckOk: true },
  { name: 'Barnyard Tapes Lo-Fi', url: 'https://radio.example/barnyard-lofi', tags: ['lofi', 'folk'], country: 'United States', countrycode: 'US', language: 'English', codec: 'MP3', bitrate: 128, votes: 5_340, clickcount: 2_640, clicktrend: 33, hls: false, lastCheckOk: true },
  { name: 'Study Window', url: 'https://radio.example/study-window', tags: ['lofi', 'ambient'], country: 'Japan', countrycode: 'JP', language: 'Japanese', codec: 'AAC', bitrate: 96, votes: 3_870, clickcount: 1_990, clicktrend: 15, hls: false, lastCheckOk: true },
  { name: 'World Service Headlines', url: 'https://radio.example/headlines', tags: ['news', 'talk'], country: 'United Kingdom', countrycode: 'GB', language: 'English', codec: 'MP3', bitrate: 96, votes: 14_200, clickcount: 9_800, clicktrend: 55, hls: false, lastCheckOk: true },
  { name: 'Harbour Report', url: 'https://radio.example/harbour-report', tags: ['news', 'local'], country: 'Ireland', countrycode: 'IE', language: 'English', codec: 'MP3', bitrate: 128, votes: 2_450, clickcount: 640, clicktrend: -7, hls: false, lastCheckOk: true },
  { name: 'Cascada Bolero', url: 'https://radio.example/cascada', tags: ['latin', 'bolero'], country: 'Spain', countrycode: 'ES', language: 'Spanish', codec: 'AAC', bitrate: 160, votes: 4_110, clickcount: 980, clicktrend: 6, hls: false, lastCheckOk: true },
  { name: 'Highlife Hour', url: 'https://radio.example/highlife', tags: ['jazz', 'highlife'], country: 'Ghana', countrycode: 'GH', language: 'English', codec: 'MP3', bitrate: 192, votes: 6_980, clickcount: 1_830, clicktrend: 24, hls: false, lastCheckOk: true },
  { name: 'Ferrous Choir', url: 'https://radio.example/ferrous-choir', tags: ['post-rock', 'ambient'], country: 'Canada', countrycode: 'CA', language: 'English', codec: 'AAC', bitrate: 256, votes: 3_240, clickcount: 760, clicktrend: 2, hls: false, lastCheckOk: true },
  { name: 'Quiet House Classics', url: 'https://radio.example/quiet-house', tags: ['classical', 'minimalism'], country: 'France', countrycode: 'FR', language: 'French', codec: 'MP3', bitrate: 192, votes: 5_670, clickcount: 1_450, clicktrend: 11, hls: false, lastCheckOk: true },
];

const STATIONS: RadioStation[] = SEEDS.map((s, i) => {
  const stationuuid = `mock-${String(i + 1).padStart(3, '0')}-${hashString(s.name).toString(36)}`;
  const id = `rs:${stationuuid}`;
  return { ...s, id, stationuuid, logoUrl: mockCover(id, s.name), favourite: false };
});

const initialFav = new Set([STATIONS[0]!.id, STATIONS[4]!.id]);
const favourites = new Set(initialFav);

const stationView = (s: RadioStation): RadioStation => ({ ...s, tags: [...s.tags], favourite: favourites.has(s.id) });

function match(st: RadioStation, p: RadioSearchParams): boolean {
  if (p.tag && !st.tags.some((t) => t.toLowerCase() === p.tag!.toLowerCase())) return false;
  if (p.country && !(st.country ?? '').toLowerCase().includes(p.country.toLowerCase())) return false;
  if (p.language && !(st.language ?? '').toLowerCase().includes(p.language.toLowerCase())) return false;
  if (p.q) {
    const q = p.q.toLowerCase();
    const hay = [st.name, st.country ?? '', st.language ?? '', ...st.tags].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sorted(list: RadioStation[], sort: RadioSearchParams['sort']): RadioStation[] {
  const out = list.slice();
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'bitrate') out.sort((a, b) => b.bitrate - a.bitrate || b.votes - a.votes);
  else if (sort === 'clickcount') out.sort((a, b) => b.clickcount - a.clickcount);
  else out.sort((a, b) => b.votes - a.votes);
  return out;
}

// ---------- rune radio ----------
interface LocalTrack { track: Track; album: Album }

const LOCAL: LocalTrack[] = ALBUMS.filter((a) => a.source === 'local').flatMap((album) => album.tracks.map((track) => ({ track, album })));
const byId = new Map(LOCAL.map((x) => [x.track.id, x]));

function findAlbums(seed: LocalTrack): Album[] {
  const genre = new Set(seed.album.genres.map((g) => g.toLowerCase()));
  return ALBUMS.filter((a) => a.source === 'local' && a.id !== seed.album.id)
    .map((a) => ({ a, score: a.genres.filter((g) => genre.has(g.toLowerCase())).length * 10 + (a.artist.id === seed.album.artist.id ? 14 : 0) + (a.year && seed.album.year && Math.abs(a.year - seed.album.year) < 6 ? 3 : 0) }))
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

function reasonFor(x: LocalTrack, seed: LocalTrack, kind: RadioFrom, i: number): string {
  const artist = x.track.artists[0]?.name ?? x.album.artist.name;
  if (x.track.id === seed.track.id) return kind === 'track' ? 'Starting point' : `From ${seed.album.title}`;
  if (x.album.id === seed.album.id) return `Also on ${seed.album.title}`;
  if (x.album.artist.id === seed.album.artist.id) return `More from ${artist}`;
  const genre = seed.album.genres[0] ?? x.album.genres[0] ?? 'Similar sound';
  if (x.album.genres.some((g) => seed.album.genres.includes(g))) return `${genre} · ${x.album.year ?? 'similar era'}`;
  if (i % 4 === 0) return `Because you like ${seed.album.artist.name}`;
  return `Deep cut · ${x.album.title}`;
}

function plan(seed: LocalTrack, kind: RadioFrom, count = 14): RadioPick[] {
  const albums = findAlbums(seed);
  const pool: LocalTrack[] = [];
  // seed first for a track; the seed album first for an album; the artist's other records for an artist.
  if (kind === 'track') pool.push(seed);
  for (const a of [seed.album, ...albums]) {
    for (const track of a.tracks) {
      const lt = byId.get(track.id);
      if (lt && !pool.some((p) => p.track.id === lt.track.id)) pool.push(lt);
    }
  }
  const head = pool.slice(0, Math.min(count, 4));
  const rest = pool.slice(4);
  // deterministic shuffle of the tail so each seed has its own order
  const r = rng(hashString(seed.track.id + kind));
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [rest[i], rest[j]] = [rest[j] as LocalTrack, rest[i] as LocalTrack];
  }
  return [...head, ...rest].slice(0, count).map((x, i) => ({ trackId: x.track.id, reason: reasonFor(x, seed, kind, i) }));
}

function startFrom(from: RadioFrom, id: string): RadioStartResult {
  const seed = from === 'track' ? byId.get(id) : from === 'album'
    ? LOCAL.find((x) => x.album.id === id)
    : LOCAL.find((x) => x.album.artist.id === id || x.track.artists.some((a) => a.id === id));
  if (!seed) return { trackIds: [], picks: [] };
  const picks = plan(seed, from);
  return { trackIds: picks.map((p) => p.trackId), picks };
}

function nextPicks(trackIds: string[], recent: string[]): RadioPick[] {
  const seed = trackIds.map((id) => byId.get(id)).find(Boolean);
  if (!seed) return [];
  const exclude = new Set([...trackIds, ...recent]);
  const candidates = plan(seed, 'artist', 40).filter((p) => !exclude.has(p.trackId));
  return candidates.slice(0, 12);
}

// ---------- state ----------
let autoRadioOn = true;
let normalizeMode: NormalizeMode = 'album';

export const mockListen = {
  radioStart(from: RadioFrom, id: string, _count?: number): Promise<RadioStartResult> {
    return wait(startFrom(from, id), 220);
  },
  radioNext(trackIds: string[], recentTrackIds: string[], _count?: number): Promise<RadioStartResult> {
    const picks = nextPicks(trackIds, recentTrackIds);
    return wait({ trackIds: picks.map((p) => p.trackId), picks }, 180);
  },
  autoRadio(): Promise<boolean> {
    return wait(autoRadioOn, 40);
  },
  setAutoRadio(enabled: boolean): Promise<boolean> {
    autoRadioOn = enabled;
    return wait(autoRadioOn, 80);
  },
  normalize(): Promise<NormalizeMode> {
    return wait(normalizeMode, 30);
  },
  setNormalize(mode: NormalizeMode): Promise<NormalizeMode> {
    normalizeMode = mode;
    return wait(normalizeMode, 80);
  },
  stations(params: RadioSearchParams = {}): Promise<RadioSearchResult> {
    const all = sorted(STATIONS.filter((s) => match(s, params)), params.sort).map(stationView);
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(1, params.limit ?? 40);
    return wait({ items: all.slice(offset, offset + limit), total: all.length }, 260);
  },
  favourites(): Promise<RadioStation[]> {
    return wait([...favourites].map((id) => STATIONS.find((s) => s.id === id)).filter(Boolean).map((s) => stationView(s as RadioStation)), 120);
  },
  addFavourite(id: string): Promise<RadioStation | undefined> {
    const st = STATIONS.find((s) => s.id === id);
    if (!st) return wait(undefined, 40);
    favourites.add(id);
    return wait(stationView(st), 100);
  },
  removeFavourite(id: string): Promise<void> {
    favourites.delete(id);
    return wait(undefined, 80);
  },
  station(id: string): Promise<RadioStation | undefined> {
    const st = STATIONS.find((s) => s.id === id);
    return wait(st ? stationView(st) : undefined, 60);
  },
  track(id: string): Promise<Track | null> {
    for (const a of ALBUMS) {
      const t = a.tracks.find((x) => x.id === id);
      if (t) return wait(t, 30);
    }
    return wait(null, 30);
  },
  peaks(trackId: string, buckets: number): Promise<PeaksResult | null> {
    if (trackId.startsWith('sp:') || trackId.startsWith('rs:') || ![...ALBUMS].some((a) => a.tracks.some((t) => t.id === trackId))) return wait(null, 40);
    const n = Math.max(8, Math.min(2000, Math.round(buckets)));
    const r = rng(hashString(trackId + ':' + n));
    const data = Array.from({ length: n }, (_, i) => {
      const env = 0.32 + 0.42 * Math.abs(Math.sin(i * 0.061 + (i % 13) * 0.017));
      const beat = i % 11 < 2 ? 0.22 : i % 7 < 1 ? 0.1 : 0;
      const v = Math.min(1, Math.max(0.035, env * 0.62 + r() * 0.26 + beat));
      return Math.round(v * 1000) / 1000;
    });
    return wait({ buckets: n, data }, 160);
  },
};

export { STATIONS as MOCK_STATIONS };
