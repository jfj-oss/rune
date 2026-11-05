// Types + pure helpers for the discover surfaces: people, editions/discography,
// listening stats, duplicate detection and server health. The server shapes live
// in server/src/{people,editions,stats,library,ops}; @liner/shared is frozen, so
// they are mirrored here (the same pattern as lib/types.ts for browse routes).
import type { AlbumSummary, ArtistRef, Id } from '@liner/shared';

// ---------- people ----------

export interface PersonRoleCount {
  role: string;
  /** Distinct albums on which this role is credited. */
  count: number;
}

export interface PersonCreditAlbum {
  album: AlbumSummary;
  /** Whole-album and track-level roles merged. */
  roles: string[];
  /** Track-level credits only. */
  tracks?: { id: Id; title: string }[];
}

export interface PersonCollaborator {
  artist: ArtistRef;
  sharedAlbums: number;
}

export interface PersonRelation {
  id: string;
  name: string;
  roles?: string[];
  begin?: number;
  end?: number;
}

export interface MbRelations {
  type?: string;
  isPerson: boolean;
  memberOf: PersonRelation[];
  members: PersonRelation[];
}

export interface PersonPage {
  id: Id;
  name: string;
  roles: PersonRoleCount[];
  asArtist: AlbumSummary[];
  credits: PersonCreditAlbum[];
  collaborators: PersonCollaborator[];
  musicbrainz?: MbRelations;
}

export interface PersonSummary {
  id: Id;
  name: string;
  albumCount: number;
  roles: string[];
}

export interface AlbumConnectionPerson {
  artist: ArtistRef;
  roles: string[];
}

export interface AlbumConnection {
  album: AlbumSummary;
  people: AlbumConnectionPerson[];
}

export interface AlbumConnections {
  albumId: Id;
  connections: AlbumConnection[];
}

// ---------- editions + discography ----------

export interface Edition {
  mbReleaseId: string;
  title: string;
  date?: string;
  country?: string;
  label?: string;
  catalogNumber?: string;
  format?: string;
  trackCount: number;
  isThisOne: boolean;
}

export interface AlbumEditions {
  originalReleaseDate?: string;
  releaseGroupType?: string;
  secondaryTypes: string[];
  editions: Edition[];
  otherVersionsInLibrary: AlbumSummary[];
}

export interface DiscographyReleaseGroup {
  mbReleaseGroupId: string;
  title: string;
  year?: number;
  date?: string;
  type?: string;
  secondaryTypes: string[];
  owned: boolean;
  albumIds: Id[];
}

export interface ArtistDiscography {
  releaseGroups: DiscographyReleaseGroup[];
}

export type DiscogSectionId = 'albums' | 'eps' | 'live' | 'compilations' | 'other';

export interface DiscogSection {
  id: DiscogSectionId;
  label: string;
  items: DiscographyReleaseGroup[];
}

// ---------- listening statistics ----------

export type StatsPeriod = '7d' | '30d' | '365d' | 'all';

export const STATS_PERIODS: { id: StatsPeriod; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '365d', label: 'Year' },
  { id: 'all', label: 'All time' },
];

export interface DayStat {
  /** YYYY-MM-DD, server timezone. */
  date: string;
  ms: number;
}

export interface TopAlbumStat {
  albumId: Id;
  title: string;
  artist: string | null;
  plays: number;
  totalMs: number;
  lastPlayedAt?: number;
}

export interface TopArtistStat {
  artistId: Id;
  name: string;
  plays: number;
  totalMs: number;
  albumCount: number;
}

export interface TopTrackStat {
  trackId: Id;
  title: string;
  albumId: Id;
  albumTitle: string | null;
  artist: string | null;
  plays: number;
  totalMs: number;
  lastPlayedAt: number;
}

export interface TopGenreStat {
  genre: string;
  plays: number;
  totalMs: number;
}

export interface NewDiscovery {
  artistId: Id;
  name: string;
  firstPlayedAt: number;
  plays: number;
}

export interface FormatShare {
  lossless: number;
  hiRes: number;
}

export interface StatsSummary {
  period: StatsPeriod;
  from: number | null;
  to: number;
  totalMs: number;
  plays: number;
  distinctAlbums: number;
  distinctArtists: number;
  topAlbums: TopAlbumStat[];
  topArtists: TopArtistStat[];
  topTracks: TopTrackStat[];
  topGenres: TopGenreStat[];
  byHour: number[];
  byWeekday: number[];
  byDay: DayStat[];
  newDiscoveries: NewDiscovery[];
  formats: FormatShare;
}

export interface AlbumStats {
  albumId: Id;
  title: string;
  artist: { id: Id; name: string } | null;
  from: number | null;
  to: number;
  plays: number;
  totalMs: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  byDay: DayStat[];
  topTracks: TopTrackStat[];
}

export interface ArtistStats {
  artistId: Id;
  name: string;
  from: number | null;
  to: number;
  plays: number;
  totalMs: number;
  firstPlayedAt: number | null;
  lastPlayedAt: number | null;
  byDay: DayStat[];
  topAlbums: TopAlbumStat[];
  topTracks: TopTrackStat[];
}

/** Album title for matching across catalogues: no case, punctuation or edition suffix ("(Deluxe)", "- Remastered"). */
export function discogTitleKey(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*(?:deluxe|remaster|expanded|edition|anniversary|bonus)[^)\]]*[)\]]/gi, ' ')
    .replace(/\s+-\s+.*(?:deluxe|remaster|expanded|edition|anniversary).*$/i, ' ')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The artist page lists MusicBrainz release groups, but only what rune knows can be opened. `playable` is each
 * unowned group's album of that title (a Spotify one, usually); `extras` are the albums no group accounts for, so
 * nothing the artist page knows about disappears behind the MusicBrainz list.
 */
export function placeAlbums<A extends { id: string; title: string }>(groups: DiscographyReleaseGroup[], albums: A[]): { playable: Map<string, A>; extras: A[] } {
  const inGroups = new Set(groups.flatMap((g) => g.albumIds));
  const byTitle = new Map<string, A>();
  for (const x of albums) if (!inGroups.has(x.id) && !byTitle.has(discogTitleKey(x.title))) byTitle.set(discogTitleKey(x.title), x);
  const playable = new Map<string, A>();
  const used = new Set<string>(inGroups);
  for (const g of groups) {
    const key = discogTitleKey(g.title);
    const hit = byTitle.get(key);
    if (hit && !g.owned) playable.set(g.mbReleaseGroupId, hit);
    // An owned group already shows this title: another copy under it is the same album, not an extra.
    if (key) for (const x of albums) if (discogTitleKey(x.title) === key) used.add(x.id);
  }
  return { playable, extras: albums.filter((x) => !used.has(x.id)) };
}

// ---------- duplicates ----------

export type DuplicateGroupKind = 'release-group' | 'same-title' | 'mixed';

export interface DuplicateAlbumVersion {
  albumId: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  format?: string;
  folderPath?: string;
  folderName?: string;
  trackCount: number;
  discCount: number;
  lossless: boolean;
  bitDepth?: number;
  sampleRate?: number;
  bitrateKbps?: number;
  hasCover: boolean;
  matched: boolean;
  matchConfidence?: number;
  hidden: boolean;
  preferredOver?: string;
  recommended: boolean;
}

export interface DuplicateGroup {
  id: string;
  kind: DuplicateGroupKind;
  title: string;
  artist: string;
  match: {
    releaseGroupIds: string[];
    titleKeys: string[];
    trackOverlap?: number;
  };
  albums: DuplicateAlbumVersion[];
  bestAlbumId: string;
  reason: string;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  trackGroups: unknown[];
  albumsScanned: number;
  tracksScanned: number;
}

// ---------- server health ----------

export interface LibraryRootStatus {
  path: string;
  mounted: boolean;
  readOnly: boolean;
  free: number;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeS: number;
  db: { albums: number; tracks: number; sizeMB: number };
  library: { roots: LibraryRootStatus[]; lastScanAt: number | null };
  mpv: { pid?: number; alive: boolean };
  spotify: { connected: boolean };
  jobs: { matching: boolean; details: boolean; loudness?: boolean };
}

// ---------- artist info ----------

export interface ArtistImageCredit {
  author?: string;
  license?: string;
  url: string;
}

export interface ArtistInfo {
  bio?: { value: string; source: string; url: string };
  imageUrl?: string;
  imageCredit?: ArtistImageCredit;
}

// ============================================================== helpers

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "42 min", "12 hr 40 min" — hero listening-time number. */
export function formatListening(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const mins = Math.round(total / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

/** "4 Mar 1977"; tolerates partial dates ("1977", "1977-03"). */
export function formatShortDate(iso: string | undefined | null): string {
  if (!iso) return '';
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(iso.trim());
  if (!m) return iso;
  const year = m[1] as string;
  if (!m[2]) return year;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  if (!m[3]) return `${month} ${year}`;
  return `${Number(m[3])} ${month} ${year}`;
}

/** Epoch ms -> "12 Mar 2026" in the viewer's local timezone. */
export function formatStamp(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** One-decimal percentage, e.g. 62.4 -> "62.4%". */
export function formatShare(percent: number): string {
  return `${(Math.round(percent * 10) / 10).toFixed(1)}%`;
}

/** Bytes for the health panel: "1.4 TB", "860 GB", "12 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** Scale a list of values to 0..1 (max = 1); all-zero stays all-zero. */
export function normalizeBars(values: number[]): number[] {
  const max = Math.max(0, ...values);
  return values.map((v) => (max > 0 && Number.isFinite(v) ? Math.max(0, v) / max : 0));
}

/** 0..23 local hour label: "00", "06", "12", "18". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function localIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIsoDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Fill a sparse `byDay` list into one point per calendar day between `from`
 * (or the first known day) and `to`, then downsample to at most `maxPoints`
 * buckets for the sparkline. Buckets sum their listening time.
 */
export function dailySeries(byDay: DayStat[], from: number | null, to: number, maxPoints = 60): DayStat[] {
  if (byDay.length === 0) return [];
  const known = byDay.filter((d) => parseIsoDay(d.date));
  if (known.length === 0) return [];
  const sorted = known.slice().sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0] as DayStat;
  const start = (from != null ? new Date(from) : parseIsoDay(first.date)) as Date;
  const end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  if (start > end) return [];
  const sums = new Map<string, number>();
  for (const d of sorted) sums.set(d.date, (sums.get(d.date) ?? 0) + Math.max(0, d.ms));

  const filled: DayStat[] = [];
  const cursor = new Date(start);
  // Guard against a pathological range.
  let guard = 0;
  while (cursor <= end && guard++ < 4000) {
    const date = localIso(cursor);
    filled.push({ date, ms: sums.get(date) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  if (filled.length === 0) return [];
  if (filled.length <= maxPoints) return filled;

  const bucket = Math.ceil(filled.length / maxPoints);
  const out: DayStat[] = [];
  for (let i = 0; i < filled.length; i += bucket) {
    const slice = filled.slice(i, i + bucket);
    out.push({ date: (slice[0] as DayStat).date, ms: slice.reduce((n, d) => n + d.ms, 0) });
  }
  return out;
}

/** Sparkline points for an SVG viewBox (width x height), oldest first. */
export function sparklinePath(points: DayStat[], width = 320, height = 80, pad = 4): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const y = height - pad;
    return `M ${pad} ${y} L ${width - pad} ${y}`;
  }
  const max = Math.max(1, ...points.map((p) => p.ms));
  return points
    .map((p, i) => {
      const x = pad + (i / (points.length - 1)) * (width - pad * 2);
      const y = height - pad - (Math.max(0, p.ms) / max) * (height - pad * 2);
      return `${i === 0 ? 'M' : 'L'} ${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

// ---------- people roles ----------

export type RoleBucket = 'all' | 'producers' | 'engineers' | 'musicians' | 'composers';

export const ROLE_BUCKETS: { id: RoleBucket; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'producers', label: 'Producers' },
  { id: 'engineers', label: 'Engineers' },
  { id: 'musicians', label: 'Musicians' },
  { id: 'composers', label: 'Composers' },
];

/**
 * Bucket a credit role. Producers first (an "Executive Producer" is a
 * producer), then engineering, then writing/composition; everything else is a
 * performance role ("Musicians").
 */
export function roleBucketOf(role: string): Exclude<RoleBucket, 'all'> {
  if (/produc/i.test(role)) return 'producers';
  if (/engineer|mix|master|record/i.test(role)) return 'engineers';
  if (/compos|lyric|writ|songwrit|arrang/i.test(role)) return 'composers';
  return 'musicians';
}

/** A person belongs to a bucket when any of their roles does. */
export function personInBucket(roles: string[], bucket: RoleBucket): boolean {
  if (bucket === 'all') return true;
  return roles.some((role) => roleBucketOf(role) === bucket);
}

// ---------- discography ----------

export function discogSectionOf(type: string | undefined): DiscogSectionId {
  const t = (type ?? '').trim().toLowerCase();
  if (t === 'ep') return 'eps';
  if (t === 'live') return 'live';
  if (t === 'compilation') return 'compilations';
  if (!t || t === 'album') return 'albums';
  return 'other';
}

const SECTION_LABEL: Record<DiscogSectionId, string> = {
  albums: 'Albums',
  eps: 'EPs',
  live: 'Live',
  compilations: 'Compilations',
  other: 'Other releases',
};

const SECTION_ORDER: DiscogSectionId[] = ['albums', 'eps', 'live', 'compilations', 'other'];

/**
 * Group release groups into the artist-page sections and show newest first
 * within each (server order is oldest first).
 */
export function groupDiscography(groups: DiscographyReleaseGroup[]): DiscogSection[] {
  const buckets = new Map<DiscogSectionId, DiscographyReleaseGroup[]>();
  for (const g of groups) {
    const id = discogSectionOf(g.type);
    const list = buckets.get(id);
    if (list) list.push(g);
    else buckets.set(id, [g]);
  }
  const out: DiscogSection[] = [];
  for (const id of SECTION_ORDER) {
    const items = buckets.get(id);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => {
      // Newest first; fall back to year then title.
      const da = a.date ?? (a.year ? String(a.year) : '');
      const db = b.date ?? (b.year ? String(b.year) : '');
      if (da !== db) return db.localeCompare(da);
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    });
    out.push({ id, label: SECTION_LABEL[id], items });
  }
  return out;
}

// ---------- duplicates ----------

export function duplicateKindLabel(kind: DuplicateGroupKind): string {
  return kind === 'release-group'
    ? 'Same release'
    : kind === 'same-title'
      ? 'Same title and tracks'
      : 'Matching release and tracks';
}

/** Short "FLAC 24/96 · 12 tracks · 2 discs" style line for a duplicate version. */
export function formatVersionDetail(v: DuplicateAlbumVersion): string {
  const parts: string[] = [];
  if (v.format) parts.push(v.format);
  parts.push(`${v.trackCount} ${v.trackCount === 1 ? 'track' : 'tracks'}`);
  if (v.discCount > 1) parts.push(`${v.discCount} discs`);
  return parts.join(' · ');
}
