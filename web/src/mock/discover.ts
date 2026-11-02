// Mock fixtures for the discover surfaces (?mock=1): people, album connections,
// editions + discography, listening stats, duplicate groups, server health and
// artist info. Everything is derived from the fixture library in ./data so the
// screens link to real mock albums/artists.
import type { Album, AlbumSummary, Track } from '@liner/shared';
import type {
  AlbumConnections,
  AlbumEditions,
  AlbumStats,
  ArtistDiscography,
  ArtistInfo,
  ArtistStats,
  DayStat,
  DiscographyReleaseGroup,
  DuplicateAlbumVersion,
  DuplicateGroup,
  DuplicateReport,
  Edition,
  HealthResponse,
  NewDiscovery,
  PersonCollaborator,
  PersonCreditAlbum,
  PersonPage,
  PersonSummary,
  PersonRoleCount,
  StatsPeriod,
  StatsSummary,
  TopAlbumStat,
  TopArtistStat,
  TopGenreStat,
  TopTrackStat,
} from '../lib/discover';
import { formatVersionDetail } from '../lib/discover';
import { hashString } from '../lib/color';
import {
  ALBUMS,
  FULL_ALBUM_ID,
  LOWCONF_ALBUM_ID,
  MULTI_ALBUM_ID,
  artistRefs,
  buildArtist,
  hex16,
  rng,
  toSummary,
} from './data';
import { mockCover } from './covers';
import { inLibrary } from './spotify';

const wait = <T>(v: T, ms = 140): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const DAY = 86_400_000;
const NOW = Date.now();

const libraryAlbums = () => ALBUMS.filter(inLibrary);
const albumByTitle = (title: string) => ALBUMS.find((a) => a.title === title && inLibrary(a));

function nameOf(id: string): string | undefined {
  const ref = artistRefs.find((a) => a.id === id);
  if (ref) return ref.name;
  for (const al of ALBUMS) for (const c of al.credits) if (c.artist.id === id) return c.artist.name;
  return undefined;
}

function summaryOf(a: Album): AlbumSummary {
  return toSummary(a);
}

// ----------------------------------------------------------------- people

interface PersonAgg {
  id: string;
  name: string;
  albums: Set<string>;
  roles: Set<string>;
}

function peopleIndex(): Map<string, PersonAgg> {
  const map = new Map<string, PersonAgg>();
  for (const al of libraryAlbums()) {
    for (const c of al.credits) {
      let p = map.get(c.artist.id);
      if (!p) {
        p = { id: c.artist.id, name: c.artist.name, albums: new Set(), roles: new Set() };
        map.set(c.artist.id, p);
      }
      p.albums.add(al.id);
      p.roles.add(c.role);
    }
  }
  return map;
}

function personSummary(p: PersonAgg): PersonSummary {
  return { id: p.id, name: p.name, albumCount: p.albums.size, roles: [...p.roles].sort((a, b) => a.localeCompare(b)) };
}

function buildPerson(id: string): PersonPage {
  const name = nameOf(id);
  if (!name) throw new Error('404 not found');
  const lib = libraryAlbums();
  const roleAlbums = new Map<string, Set<string>>();
  const credits: PersonCreditAlbum[] = [];
  const collaborators = new Map<string, { artist: { id: string; name: string }; albums: Set<string> }>();

  for (const al of lib) {
    const mine = al.credits.filter((c) => c.artist.id === id);
    if (mine.length === 0) continue;
    const roles = [...new Set(mine.map((c) => c.role))];
    for (const role of roles) {
      let set = roleAlbums.get(role);
      if (!set) {
        set = new Set();
        roleAlbums.set(role, set);
      }
      set.add(al.id);
    }

    const trackIds = new Set<string>();
    for (const c of mine) for (const tid of c.trackIds ?? []) trackIds.add(tid);
    const tracks = al.tracks
      .filter((t) => trackIds.has(t.id))
      .map((t) => ({ id: t.id, title: t.title }));

    credits.push({
      album: summaryOf(al),
      roles,
      ...(tracks.length > 0 ? { tracks } : {}),
    });

    const others = new Set((al.credits ?? []).filter((c) => c.artist.id !== id).map((c) => c.artist.id));
    for (const other of others) {
      let entry = collaborators.get(other);
      if (!entry) {
        entry = { artist: { id: other, name: nameOf(other) ?? 'Unknown Artist' }, albums: new Set() };
        collaborators.set(other, entry);
      }
      entry.albums.add(al.id);
    }
  }

  credits.sort(
    (a, b) => (a.album.year ?? 9999) - (b.album.year ?? 9999) || a.album.title.localeCompare(b.album.title),
  );

  const roles: PersonRoleCount[] = [...roleAlbums.entries()]
    .map(([role, albums]) => ({ role, count: albums.size }))
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));

  const asArtist = lib
    .filter((a) => a.artist.id === id)
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title))
    .map(summaryOf);

  const collabs: PersonCollaborator[] = [...collaborators.values()]
    .map((c) => ({ artist: c.artist, sharedAlbums: c.albums.size }))
    .sort((a, b) => b.sharedAlbums - a.sharedAlbums || a.artist.name.localeCompare(b.artist.name))
    .slice(0, 12);

  return { id, name, roles, asArtist, credits, collaborators: collabs };
}

// ------------------------------------------------- album → album links

function buildConnections(albumId: string): AlbumConnections {
  const source = ALBUMS.find((a) => a.id === albumId);
  if (!source) throw new Error('404 not found');
  const sourcePeople = new Set(source.credits.map((c) => c.artist.id));
  const connections: AlbumConnections['connections'] = [];

  for (const al of libraryAlbums()) {
    if (al.id === albumId) continue;
    const shared = new Map<string, { name: string; roles: Set<string> }>();
    for (const c of al.credits) {
      if (!sourcePeople.has(c.artist.id)) continue;
      let person = shared.get(c.artist.id);
      if (!person) {
        person = { name: c.artist.name, roles: new Set() };
        shared.set(c.artist.id, person);
      }
      person.roles.add(c.role);
    }
    if (shared.size === 0) continue;
    connections.push({
      album: summaryOf(al),
      people: [...shared.entries()]
        .map(([id, p]) => ({ artist: { id, name: p.name }, roles: [...p.roles].sort((a, b) => a.localeCompare(b)) }))
        .sort((a, b) => a.artist.name.localeCompare(b.artist.name)),
    });
  }

  connections.sort(
    (a, b) =>
      b.people.length - a.people.length ||
      (a.album.year ?? 9999) - (b.album.year ?? 9999) ||
      a.album.title.localeCompare(b.album.title),
  );
  return { albumId, connections };
}

// --------------------------------------------------- editions + discography

function inferType(a: Album): string {
  const t = a.title.toLowerCase();
  if (/\blive\b/.test(t)) return 'Live';
  if (/\bep\b|ep\b/.test(t)) return 'EP';
  if (/compilation|best of|greatest hits/.test(t)) return 'Compilation';
  return 'Album';
}

function edition(
  id: string,
  title: string,
  date: string,
  country: string,
  label: string,
  catalogNumber: string,
  format: string,
  trackCount: number,
  isThisOne: boolean,
): Edition {
  return { mbReleaseId: id, title, date, country, label, catalogNumber, format, trackCount, isThisOne };
}

function buildEditions(albumId: string): AlbumEditions {
  const album = ALBUMS.find((a) => a.id === albumId);
  if (!album) throw new Error('404 not found');

  if (album.id === FULL_ALBUM_ID) {
    const live = ALBUMS.find((a) => a.source === 'spotify' && a.artist.id === album.artist.id);
    return {
      originalReleaseDate: '1977-03-04',
      releaseGroupType: 'Album',
      secondaryTypes: [],
      editions: [
        edition('mb-gl-1', 'Glass Harbour', '1977-03-04', 'US', 'Northlight Records', 'NL-7704', 'Vinyl', 10, true),
        edition('mb-gl-2', 'Glass Harbour', '1977-06-10', 'GB', 'Northlight Records', 'NL-7704 GB', 'Vinyl', 10, false),
        edition('mb-gl-3', 'Glass Harbour (Remastered)', '2012-09-18', 'XW', 'Northlight Records', 'NL-2012', 'CD', 12, false),
        edition('mb-gl-4', 'Glass Harbour', '2012-09-18', 'US', 'Northlight Records', '—', 'Digital', 10, false),
      ],
      otherVersionsInLibrary: live ? [summaryOf(live)] : [],
    };
  }

  if (album.id === MULTI_ALBUM_ID) {
    return {
      originalReleaseDate: '1974-05-17',
      releaseGroupType: 'Album',
      secondaryTypes: [],
      editions: [
        edition('mb-ld-1', 'Long Division', '1974-05-17', 'US', 'Meridian Gramophone', 'MG-2201', 'Vinyl', 12, true),
        edition('mb-ld-2', 'Long Division', '1998-11-02', 'GB', 'Meridian Gramophone', 'MG-2201 CD', 'CD', 12, false),
      ],
      otherVersionsInLibrary: [],
    };
  }

  const type = inferType(album);
  return {
    ...(album.releaseDate || album.year ? { originalReleaseDate: album.releaseDate ?? String(album.year) } : {}),
    releaseGroupType: type,
    secondaryTypes: type === 'Live' ? ['Live'] : type === 'Compilation' ? ['Compilation'] : [],
    editions: [],
    otherVersionsInLibrary: [],
  };
}

const EXTRA_DISCOGRAPHY: Record<string, DiscographyReleaseGroup[]> = {
  [artistRefs[0]!.id]: [
    {
      mbReleaseGroupId: 'rg:harbour-lights-ep',
      title: 'Harbour Lights EP',
      year: 1979,
      date: '1979-04-20',
      type: 'EP',
      secondaryTypes: [],
      owned: false,
      albumIds: [],
    },
    {
      mbReleaseGroupId: 'rg:an-evening-with-aster-vale',
      title: 'An Evening with Aster Vale',
      year: 1981,
      date: '1981-10-09',
      type: 'Live',
      secondaryTypes: ['Live'],
      owned: false,
      albumIds: [],
    },
    {
      mbReleaseGroupId: 'rg:quiet-rooms',
      title: 'Quiet Rooms: 1975–1991',
      year: 1995,
      date: '1995-06-12',
      type: 'Compilation',
      secondaryTypes: ['Compilation'],
      owned: false,
      albumIds: [],
    },
    {
      mbReleaseGroupId: 'rg:the-copper-year',
      title: 'The Copper Year',
      year: 1984,
      date: '1984-02-03',
      type: 'Album',
      secondaryTypes: [],
      owned: false,
      albumIds: [],
    },
  ],
  [artistRefs[1]!.id]: [
    {
      mbReleaseGroupId: 'rg:paper-tides-ep',
      title: 'Paper Tides',
      year: 1971,
      date: '1971-09-01',
      type: 'EP',
      secondaryTypes: [],
      owned: false,
      albumIds: [],
    },
  ],
};

function buildDiscography(artistId: string): ArtistDiscography {
  if (!nameOf(artistId)) throw new Error('404 not found');
  const groups: DiscographyReleaseGroup[] = [];
  const seen = new Set<string>();
  for (const al of libraryAlbums().filter((a) => a.artist.id === artistId)) {
    const key = al.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const type = inferType(al);
    groups.push({
      mbReleaseGroupId: 'rg:' + hex16(al.title + '|' + artistId),
      title: al.title,
      ...(al.year ? { year: al.year } : {}),
      ...(al.releaseDate ? { date: al.releaseDate } : {}),
      type,
      secondaryTypes: type === 'Live' ? ['Live'] : type === 'Compilation' ? ['Compilation'] : [],
      owned: true,
      albumIds: [al.id],
    });
  }
  groups.push(...(EXTRA_DISCOGRAPHY[artistId] ?? []));
  return { releaseGroups: groups };
}

// --------------------------------------------------------------- statistics

interface PeriodConfig {
  days: number;
  totalMs: number;
  plays: number;
  distinctAlbums: number;
  distinctArtists: number;
  lossless: number;
  hiRes: number;
}

const PERIODS: Record<StatsPeriod, PeriodConfig> = {
  '7d': { days: 7, totalMs: 13.2 * 3_600_000, plays: 214, distinctAlbums: 41, distinctArtists: 28, lossless: 66.2, hiRes: 38.9 },
  '30d': { days: 30, totalMs: 52.8 * 3_600_000, plays: 863, distinctAlbums: 96, distinctArtists: 54, lossless: 68.4, hiRes: 41.2 },
  '365d': { days: 365, totalMs: 412 * 3_600_000, plays: 6_841, distinctAlbums: 214, distinctArtists: 103, lossless: 64.1, hiRes: 36.7 },
  all: { days: 540, totalMs: 623 * 3_600_000, plays: 10_422, distinctAlbums: 268, distinctArtists: 121, lossless: 61.8, hiRes: 34.4 },
};

const HOUR_WEIGHTS = [0.4, 0.2, 0.1, 0.05, 0.05, 0.1, 0.3, 0.8, 1.2, 1.5, 1.4, 1.3, 1.2, 1.1, 1.0, 1.0, 1.2, 1.5, 1.9, 2.3, 2.6, 2.4, 1.9, 1.2];
const WEEKDAY_WEIGHTS = [1.5, 0.8, 0.9, 1.0, 1.05, 1.25, 1.6];

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return localIso(d);
}

function scaleWeights(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => Math.round((w / sum) * total));
}

function makeDays(count: number, totalMs: number): DayStat[] {
  const r = rng(0x5eed + count);
  const weights: number[] = [];
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() - (count - 1 - i));
    const weekly = WEEKDAY_WEIGHTS[d.getDay()] ?? 1;
    weights.push(weekly * (0.55 + r()));
  }
  const scaled = scaleWeights(weights, totalMs);
  const out: DayStat[] = [];
  for (let i = 0; i < count; i++) {
    // The server only returns days with plays: leave some gaps for the sparkline.
    if (count > 10 && r() < 0.07) continue;
    out.push({ date: isoDaysAgo(count - 1 - i), ms: scaled[i] as number });
  }
  return out;
}

const TOP_PICKS = [0, 3, 1, 13, 19, 8, 10, 4, 6, 23];
const TOP_WEIGHTS = [0.11, 0.09, 0.08, 0.07, 0.06, 0.05, 0.045, 0.04, 0.035, 0.03];

function topAlbums(cfg: PeriodConfig): TopAlbumStat[] {
  const lib = libraryAlbums();
  return TOP_PICKS.map((idx, i) => {
    const al = lib[idx % lib.length] as Album;
    const plays = Math.max(2, Math.round(cfg.plays * (TOP_WEIGHTS[i] as number)));
    const avg = al.tracks.reduce((n, t) => n + t.durationMs, 0) / Math.max(1, al.tracks.length);
    return {
      albumId: al.id,
      title: al.title,
      artist: al.artist.name,
      plays,
      totalMs: Math.round(plays * avg),
      lastPlayedAt: NOW - (i + 1) * 7 * 3_600_000,
    };
  });
}

function topArtists(albums: TopAlbumStat[]): TopArtistStat[] {
  const map = new Map<string, { name: string; plays: number; totalMs: number; albums: Set<string> }>();
  for (const a of albums) {
    const album = ALBUMS.find((x) => x.id === a.albumId);
    if (!album) continue;
    const id = album.artist.id;
    let entry = map.get(id);
    if (!entry) {
      entry = { name: album.artist.name, plays: 0, totalMs: 0, albums: new Set() };
      map.set(id, entry);
    }
    entry.plays += a.plays;
    entry.totalMs += a.totalMs;
    entry.albums.add(a.albumId);
  }
  return [...map.entries()]
    .map(([artistId, v]) => ({ artistId, name: v.name, plays: v.plays, totalMs: v.totalMs, albumCount: v.albums.size }))
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, 10);
}

function topTracks(albums: TopAlbumStat[]): TopTrackStat[] {
  const out: TopTrackStat[] = [];
  for (const a of albums.slice(0, 6)) {
    const album = ALBUMS.find((x) => x.id === a.albumId);
    if (!album) continue;
    const r = rng(hashString(a.albumId));
    const picks = album.tracks
      .map((t, i) => ({ t, score: r() + (i === 2 ? 0.4 : 0) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 2);
    for (const { t } of picks) {
      out.push({
        trackId: t.id,
        title: t.title,
        albumId: album.id,
        albumTitle: album.title,
        artist: album.artist.name,
        plays: Math.max(1, Math.round(a.plays * 0.22)),
        totalMs: Math.round(Math.max(1, Math.round(a.plays * 0.22)) * t.durationMs),
        lastPlayedAt: a.lastPlayedAt ?? NOW,
      });
    }
  }
  return out.sort((a, b) => b.plays - a.plays).slice(0, 10);
}

function topGenres(albums: TopAlbumStat[]): TopGenreStat[] {
  const map = new Map<string, { plays: number; totalMs: number }>();
  for (const a of albums) {
    const album = ALBUMS.find((x) => x.id === a.albumId);
    if (!album) continue;
    for (const g of album.genres) {
      const key = g.toLowerCase();
      const entry = map.get(key) ?? { plays: 0, totalMs: 0 };
      entry.plays += Math.round(a.plays / album.genres.length);
      entry.totalMs += Math.round(a.totalMs / album.genres.length);
      map.set(key, entry);
    }
  }
  return [...map.entries()]
    .map(([genre, v]) => ({ genre: genre.replace(/\b([a-z])/g, (m) => m.toUpperCase()), plays: v.plays, totalMs: v.totalMs }))
    .sort((a, b) => b.plays - a.plays || a.genre.localeCompare(b.genre))
    .slice(0, 8);
}

function discoveries(from: number | null): NewDiscovery[] {
  return artistRefs.slice(0, 6).map((a, i) => ({
    artistId: a.id,
    name: a.name,
    firstPlayedAt: from == null ? NOW - (120 + i * 40) * DAY : from + (i + 1) * 2 * DAY,
    plays: 24 - i * 3,
  }));
}

function summary(period: StatsPeriod): StatsSummary {
  const cfg = PERIODS[period];
  const albums = topAlbums(cfg);
  const from = period === 'all' ? null : NOW - cfg.days * DAY;
  return {
    period,
    from,
    to: NOW,
    totalMs: cfg.totalMs,
    plays: cfg.plays,
    distinctAlbums: cfg.distinctAlbums,
    distinctArtists: cfg.distinctArtists,
    topAlbums: albums,
    topArtists: topArtists(albums),
    topTracks: topTracks(albums),
    topGenres: topGenres(albums),
    byHour: scaleWeights(HOUR_WEIGHTS, cfg.totalMs),
    byWeekday: scaleWeights(WEEKDAY_WEIGHTS, cfg.totalMs),
    byDay: makeDays(cfg.days, cfg.totalMs),
    newDiscoveries: discoveries(from),
    formats: { lossless: cfg.lossless, hiRes: cfg.hiRes },
  };
}

function albumStats(id: string, period: StatsPeriod): AlbumStats | null {
  const album = ALBUMS.find((a) => a.id === id);
  if (!album) return null;
  const h = hashString(id);
  const cfg = PERIODS[period];
  const scale = period === 'all' ? 1 : Math.min(1, cfg.days / 180);
  const plays = Math.max(1, Math.round((6 + (h % 27)) * scale));
  const totalMs = album.tracks.reduce((n, t) => n + t.durationMs, 0) * Math.max(1, Math.round(plays / Math.max(1, album.tracks.length)));
  const firstPlayedAt = period === 'all' ? NOW - (40 + (h % 300)) * DAY : cfg.days < 400 ? NOW - cfg.days * DAY + DAY : NOW - (40 + (h % 300)) * DAY;
  const lastPlayedAt = NOW - (h % 18) * DAY;
  const r = rng(h);
  const top = album.tracks
    .map((t) => ({ t, score: r() }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ t }) => ({
      trackId: t.id,
      title: t.title,
      albumId: album.id,
      albumTitle: album.title,
      artist: album.artist.name,
      plays: Math.max(1, Math.round(plays * (0.15 + r() * 0.25))),
      totalMs: t.durationMs,
      lastPlayedAt,
    }));
  return {
    albumId: album.id,
    title: album.title,
    artist: { id: album.artist.id, name: album.artist.name },
    from: period === 'all' ? null : NOW - cfg.days * DAY,
    to: NOW,
    plays,
    totalMs,
    firstPlayedAt,
    lastPlayedAt,
    byDay: makeDays(Math.min(cfg.days, 30), totalMs),
    topTracks: top,
  };
}

function artistStats(id: string, period: StatsPeriod): ArtistStats | null {
  const name = nameOf(id);
  if (!name) return null;
  const albums = ALBUMS.filter((a) => a.artist.id === id && inLibrary(a));
  const cfg = PERIODS[period];
  const details = albums.map((a) => albumStats(a.id, period)).filter((x): x is AlbumStats => x != null);
  const plays = details.reduce((n, a) => n + a.plays, 0);
  const totalMs = details.reduce((n, a) => n + a.totalMs, 0);
  const firsts = details.map((a) => a.firstPlayedAt).filter((x): x is number => x != null);
  const lasts = details.map((a) => a.lastPlayedAt).filter((x): x is number => x != null);
  return {
    artistId: id,
    name,
    from: period === 'all' ? null : NOW - cfg.days * DAY,
    to: NOW,
    plays,
    totalMs,
    firstPlayedAt: firsts.length ? Math.min(...firsts) : null,
    lastPlayedAt: lasts.length ? Math.max(...lasts) : null,
    byDay: makeDays(Math.min(cfg.days, 30), totalMs),
    topAlbums: details
      .map((a) => ({
        albumId: a.albumId,
        title: a.title,
        artist: a.artist?.name ?? name,
        plays: a.plays,
        totalMs: a.totalMs,
        lastPlayedAt: a.lastPlayedAt ?? undefined,
      }))
      .sort((a, b) => b.plays - a.plays),
    topTracks: details.flatMap((a) => a.topTracks).sort((a, b) => b.plays - a.plays).slice(0, 10),
  };
}

// --------------------------------------------------------------- duplicates

const hidden = new Set<string>([LOWCONF_ALBUM_ID]);

function versionFromAlbum(a: Album, recommended: boolean): DuplicateAlbumVersion {
  const tracks = a.tracks;
  const discCount = Math.max(1, ...tracks.map((t) => t.disc));
  const lossless = a.source === 'local' && (a.format ?? '').startsWith('FLAC');
  const first = tracks[0] as Track | undefined;
  return {
    albumId: a.id,
    title: a.title,
    artist: a.artist.name,
    artistId: a.artist.id,
    ...(a.year ? { year: a.year } : {}),
    ...(a.format ? { format: a.format } : {}),
    ...(a.folderPath ? { folderPath: a.folderPath } : {}),
    ...(a.folderPath ? { folderName: a.folderPath.split('/').pop() ?? a.folderPath } : {}),
    trackCount: tracks.length,
    discCount,
    lossless,
    ...(first?.bitDepth ? { bitDepth: first.bitDepth } : {}),
    ...(first?.sampleRate ? { sampleRate: first.sampleRate } : {}),
    ...(first?.bitrateKbps ? { bitrateKbps: first.bitrateKbps } : {}),
    hasCover: true,
    matched: (a.matchConfidence ?? 0) >= 0.7,
    ...(a.matchConfidence != null ? { matchConfidence: a.matchConfidence } : {}),
    hidden: hidden.has(a.id),
    recommended,
  };
}

function fabricated(
  albumId: string,
  title: string,
  artist: string,
  format: string,
  folderName: string,
  trackCount: number,
  discCount: number,
  opts: Partial<DuplicateAlbumVersion> = {},
): DuplicateAlbumVersion {
  return {
    albumId,
    title,
    artist,
    format,
    folderPath: `/mnt/BIG data/Music/${artist}/${folderName}`,
    folderName,
    trackCount,
    discCount,
    lossless: false,
    bitrateKbps: 320,
    hasCover: true,
    matched: false,
    hidden: hidden.has(albumId),
    recommended: false,
    ...opts,
  };
}

function buildDuplicateGroups(): DuplicateGroup[] {
  const glass = ALBUMS.find((a) => a.id === FULL_ALBUM_ID) as Album;
  const long = ALBUMS.find((a) => a.id === MULTI_ALBUM_ID) as Album;
  const rooms = albumByTitle('Rooms I Left');
  const low = ALBUMS.find((a) => a.id === LOWCONF_ALBUM_ID) as Album;
  const tide = albumByTitle('Tidewater');

  const groups: DuplicateGroup[] = [
    {
      id: 'dup-glass-harbour',
      kind: 'release-group',
      title: glass.title,
      artist: glass.artist.name,
      match: { releaseGroupIds: ['rg-glass-harbour'], titleKeys: ['glass harbour'], trackOverlap: 1 },
      albums: [
        versionFromAlbum(glass, true),
        fabricated('la:dup-glass-mp3', 'Glass Harbour', glass.artist.name, 'MP3 320', 'Glass Harbour (MP3 rip)', 10, 1, { year: 1977 }),
        fabricated('la:dup-glass-remaster', 'Glass Harbour (2012 Remaster)', glass.artist.name, 'FLAC 16/44.1', 'Glass Harbour [2012 remaster]', 12, 1, {
          year: 2012,
          lossless: true,
          bitDepth: 16,
          sampleRate: 44100,
          bitrateKbps: undefined,
          matched: true,
          matchConfidence: 0.91,
        }),
      ],
      bestAlbumId: glass.id,
      reason: 'FLAC 24/96 is lossless, has a confirmed MusicBrainz match and the most complete artwork.',
    },
  ];

  groups.push({
    id: 'dup-long-division',
    kind: 'same-title',
    title: long.title,
    artist: long.artist.name,
    match: { releaseGroupIds: [], titleKeys: ['long division'], trackOverlap: 0.92 },
    albums: [
      versionFromAlbum(long, true),
      fabricated('la:dup-long-cd', 'Long Division', long.artist.name, 'MP3 320', 'Long Division (CD rip)', 12, 2, { year: 1974 }),
    ],
    bestAlbumId: long.id,
    reason: 'The lossless 24/96 copy has both discs; the other version is a 320 kbps CD rip.',
  });

  if (rooms) {
    groups.push({
      id: 'dup-rooms-i-left',
      kind: 'mixed',
      title: rooms.title,
      artist: rooms.artist.name,
      match: { releaseGroupIds: ['rg-rooms-i-left'], titleKeys: ['rooms i left'], trackOverlap: 0.86 },
      albums: [
        versionFromAlbum(rooms, true),
        fabricated('la:dup-rooms-deluxe', 'Rooms I Left (Deluxe Edition)', rooms.artist.name, 'MP3 320', 'Rooms I Left (Deluxe) [2009]', 15, 1, { year: 2009 }),
        versionFromAlbum(low, false),
      ],
      bestAlbumId: rooms.id,
      reason: 'The matched FLAC copy matches the original 2008 track list; the deluxe MP3 adds six bonus tracks from a different edition.',
    });
  }

  if (tide) {
    groups.push({
      id: 'dup-tidewater',
      kind: 'release-group',
      title: tide.title,
      artist: tide.artist.name,
      match: { releaseGroupIds: ['rg-tidewater'], titleKeys: ['tidewater'], trackOverlap: 1 },
      albums: [
        versionFromAlbum(tide, true),
        fabricated('la:dup-tidewater-96', 'Tidewater', tide.artist.name, 'FLAC 24/96', 'Tidewater [hi-res]', 9, 1, {
          year: 1975,
          lossless: true,
          bitDepth: 24,
          sampleRate: 96000,
          bitrateKbps: undefined,
          matched: true,
          matchConfidence: 0.94,
        }),
      ],
      bestAlbumId: tide.id,
      reason: 'Both are FLAC and complete; the 16/44.1 copy has the confirmed match, so it stays the keeper.',
    });
  }

  return groups;
}

function duplicates(): DuplicateReport {
  const lib = libraryAlbums();
  return {
    groups: buildDuplicateGroups(),
    trackGroups: [],
    albumsScanned: lib.length,
    tracksScanned: lib.reduce((n, a) => n + a.tracks.length, 0),
  };
}

// ------------------------------------------------------------------- health

function health(): HealthResponse {
  return {
    ok: true,
    version: '0.1.0',
    uptimeS: 4 * 3600 + 18 * 60 + 42,
    db: {
      albums: ALBUMS.filter((a) => a.source === 'local').length,
      tracks: ALBUMS.filter((a) => a.source === 'local').reduce((n, a) => n + a.tracks.length, 0),
      sizeMB: 186.42,
    },
    library: {
      roots: [{ path: '/mnt/BIG data/Music', mounted: true, readOnly: false, free: 1.42 * 1024 ** 4 }],
      lastScanAt: NOW - 2 * 3_600_000,
    },
    mpv: { pid: 4242, alive: true },
    spotify: { connected: true },
    jobs: { matching: false, details: true, loudness: false },
  };
}

// -------------------------------------------------------------- artist info

function artistInfo(id: string): ArtistInfo | null {
  const name = nameOf(id);
  if (!name) return null;
  const artist = buildArtist(id);
  return {
    ...(artist?.bio ? { bio: artist.bio } : {}),
    imageUrl: mockCover('artist:' + id, name),
    imageCredit: {
      author: 'Wikimedia Commons contributors',
      license: 'CC BY-SA 4.0',
      url: 'https://commons.wikimedia.org/wiki/Category:Musicians',
    },
  };
}

// ------------------------------------------------------------------- export

export const mockDiscover = {
  async people(q: { role?: string; q?: string } = {}): Promise<PersonSummary[]> {
    let list = [...peopleIndex().values()].map(personSummary);
    if (q.role) {
      const role = q.role.toLowerCase();
      list = list.filter((p) => p.roles.some((r) => r.toLowerCase() === role));
    }
    if (q.q) {
      const text = q.q.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(text));
    }
    list.sort((a, b) => b.albumCount - a.albumCount || a.name.localeCompare(b.name));
    return wait(list, 120);
  },
  async person(id: string): Promise<PersonPage> {
    return wait(buildPerson(id), 160);
  },
  async connections(albumId: string): Promise<AlbumConnections> {
    return wait(buildConnections(albumId), 140);
  },
  async editions(albumId: string): Promise<AlbumEditions> {
    return wait(buildEditions(albumId), 160);
  },
  async discography(artistId: string): Promise<ArtistDiscography> {
    return wait(buildDiscography(artistId), 160);
  },
  async statsSummary(period: StatsPeriod): Promise<StatsSummary> {
    return wait(summary(period), 180);
  },
  async statsAlbum(id: string, period: StatsPeriod): Promise<AlbumStats | null> {
    return wait(albumStats(id, period), 120);
  },
  async statsArtist(id: string, period: StatsPeriod): Promise<ArtistStats | null> {
    return wait(artistStats(id, period), 120);
  },
  async duplicates(): Promise<DuplicateReport> {
    return wait(duplicates(), 220);
  },
  async hideAlbum(albumId: string): Promise<void> {
    hidden.add(albumId);
    return wait(undefined, 90);
  },
  async unhideAlbum(albumId: string): Promise<void> {
    hidden.delete(albumId);
    return wait(undefined, 90);
  },
  async health(): Promise<HealthResponse> {
    return wait(health(), 120);
  },
  async artistInfo(id: string): Promise<ArtistInfo | null> {
    return wait(artistInfo(id), 120);
  },
};

/** Exposed so future mock screens (and tests) can reuse a version line. */
export { formatVersionDetail };
