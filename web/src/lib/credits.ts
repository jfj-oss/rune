import type { ArtistRef, Credit, Track } from '@liner/shared';

export type CreditGroupName = 'Performers' | 'Production' | 'Writing';

export interface CreditRole {
  role: string;
  trackIds?: string[]; // absent = whole album
}

export interface CreditPerson {
  artist: ArtistRef;
  roles: CreditRole[];
}

export interface CreditGroup {
  name: CreditGroupName;
  people: CreditPerson[];
}

const PRODUCTION =
  /(produc|engineer|mix|master|record|programm|executive|a&r|assistant|editor|tracking|overdub|co-ordinat|coordinat|remix)/i;
const WRITING = /(compos|lyric|writ|songwrit|arrang|orchestrat|translat|libretto|words|music by)/i;

export function classifyRole(role: string): CreditGroupName {
  if (WRITING.test(role)) return 'Writing';
  if (PRODUCTION.test(role)) return 'Production';
  return 'Performers';
}

/**
 * Group raw credits into Performers / Production / Writing, merging the same person within a
 * group (their roles are unioned; same role on different tracks merges track ids).
 * Empty groups are omitted; order is fixed.
 */
export function groupCredits(credits: Credit[]): CreditGroup[] {
  const groups = new Map<CreditGroupName, Map<string, CreditPerson>>();
  for (const name of ['Performers', 'Production', 'Writing'] as const) groups.set(name, new Map());

  for (const c of credits) {
    const g = groups.get(classifyRole(c.role));
    if (!g) continue;
    let person = g.get(c.artist.id);
    if (!person) {
      person = { artist: c.artist, roles: [] };
      g.set(c.artist.id, person);
    }
    const existing = person.roles.find((r) => r.role.toLowerCase() === c.role.toLowerCase());
    if (!existing) {
      person.roles.push({ role: c.role, trackIds: c.trackIds ? [...c.trackIds] : undefined });
    } else if (existing.trackIds && c.trackIds) {
      existing.trackIds = [...new Set([...existing.trackIds, ...c.trackIds])];
    } else {
      existing.trackIds = undefined; // whole-album credit wins
    }
  }

  const out: CreditGroup[] = [];
  for (const [name, people] of groups) {
    if (people.size) out.push({ name, people: [...people.values()] });
  }
  return out;
}

/** "track 3", "tracks 2, 5", "tracks 2–4, 7" — numbers are positions in the album order. */
export function formatTrackRefs(trackIds: string[], tracks: Pick<Track, 'id'>[]): string {
  const nums = trackIds
    .map((id) => tracks.findIndex((t) => t.id === id) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const uniq = [...new Set(nums)];
  if (!uniq.length) return '';
  const parts: string[] = [];
  let start = uniq[0] as number;
  let prev = start;
  for (let i = 1; i <= uniq.length; i++) {
    const n = uniq[i];
    if (n !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
    if (n !== undefined) {
      start = n;
      prev = n;
    }
  }
  return `${uniq.length === 1 ? 'track' : 'tracks'} ${parts.join(', ')}`;
}
