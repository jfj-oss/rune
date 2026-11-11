// Mock Spotify account: playlists, Liked Songs (thousands of tracks) and the saved-album set.
import type { PlaylistDetail, PlaylistSummary, PlaylistTrack, Track } from '@liner/shared';
import { hashString } from '../lib/color';
import { mockCover } from './covers';
import { ALBUMS, CATALOG_IDS, WORD_A, WORD_B, hex16, rng } from './data';

export const LIKED_ID = 'pl:sp:liked';
const LIKED_COUNT = 4612;

const SPECS: { name: string; owner: string; count: number; desc?: string }[] = [
  { name: 'MYPC', owner: 'You', count: 48, desc: 'The big one. Local rips get slotted in alongside.' },
  { name: 'MUDs', owner: 'You', count: 28 },
  { name: 'Morning Harbour', owner: 'You', count: 48, desc: 'Slow starts, strong coffee, a bit of salt in the air.' },
  { name: 'Late Night Static', owner: 'You', count: 120 },
  { name: 'Road Trip 2024', owner: 'You', count: 87, desc: 'Windows down on the coast road.' },
  { name: 'Focus: Deep Time', owner: 'Spotify', count: 215 },
  { name: 'Sunday Folk', owner: 'Hollis Brandt', count: 36 },
  { name: 'Workout Mix', owner: 'You', count: 64 },
  { name: 'Rainy Day Piano', owner: 'Spotify', count: 41 },
  { name: 'Dinner Party', owner: 'You', count: 73 },
];

const idOf = (name: string) => `pl:sp:${hex16(name)}`;

export const PLAYLISTS: PlaylistSummary[] = [
  { id: LIKED_ID, name: 'Liked Songs', owner: 'You', trackCount: LIKED_COUNT, source: 'spotify', canEdit: true },
  ...SPECS.map((p): PlaylistSummary => {
    const id = idOf(p.name);
    // cover of one of the albums, like a Spotify mosaic's first tile
    const al = ALBUMS[hashString(id) % ALBUMS.length]!;
    // "You" owns it; someone else's (and Spotify's own) playlists stay read-only.
    return { id, name: p.name, owner: p.owner, trackCount: p.count, imageUrl: mockCover(al.id, al.title), source: 'spotify', canEdit: p.owner === 'You' };
  }),
];

function buildTracks(id: string, count: number): PlaylistTrack[] {
  const r = rng(hashString(id));
  const out: PlaylistTrack[] = [];
  for (let i = 0; i < count; i++) {
    const al = ALBUMS[Math.floor(r() * ALBUMS.length)]!;
    const title = `${WORD_A[Math.floor(r() * WORD_A.length)]} ${WORD_B[Math.floor(r() * WORD_B.length)]}`;
    const base = al.tracks[Math.floor(r() * al.tracks.length)] as Track;
    const tid = 'sp:' + hex16(`${id}/${i}`);
    out.push({
      ...base,
      id: tid, albumId: al.id, source: 'spotify', title, number: (i % 12) + 1, disc: 1,
      durationMs: Math.round((120 + r() * 280) * 1000),
      artists: al.artist ? [al.artist] : base.artists,
      format: undefined, sampleRate: undefined, bitDepth: undefined, bitrateKbps: undefined,
      spotifyUri: 'spotify:track:' + tid.slice(3),
      album: { id: al.id, title: al.title, coverUrl: al.coverUrl },
    });
  }
  return out;
}

const cache = new Map<string, PlaylistDetail>();
export function playlistDetail(id: string): PlaylistDetail | undefined {
  const sum = PLAYLISTS.find((p) => p.id === id);
  if (!sum) return undefined;
  let hit = cache.get(id);
  if (!hit) {
    const spec = SPECS.find((p) => idOf(p.name) === id);
    hit = { ...sum, description: spec?.desc, tracks: buildTracks(id, sum.trackCount) };
    cache.set(id, hit);
  }
  return hit;
}

/** Spotify removes every copy of a URI: mirror that in the mock playlist. */
export function removeFromPlaylistMock(id: string, trackIds: string[]): void {
  const d = playlistDetail(id);
  if (!d) return;
  const drop = new Set(trackIds);
  d.tracks = d.tracks.filter((t) => !drop.has(t.id));
  d.trackCount = d.tracks.length;
}

// ---------- liked tracks ----------
// A deterministic seed (so the demo has some hearts) plus explicit toggles.
const likedOverrides = new Map<string, boolean>();
export const isTrackLiked = (id: string) => likedOverrides.get(id) ?? hashString(id) % 5 === 0;
export const setTrackLiked = (id: string, on: boolean) => { likedOverrides.set(id, on); };

// ---------- saved albums ----------
const saved = new Set(ALBUMS.filter((a) => a.source === 'spotify' && !CATALOG_IDS.has(a.id)).map((a) => a.id));
export const isSaved = (id: string) => saved.has(id);
export const setSaved = (id: string, on: boolean) => { if (on) saved.add(id); else saved.delete(id); };
/** Is this album part of the user's library right now (local, or a saved Spotify album)? */
export const inLibrary = (a: { id: string; source: string }) => a.source !== 'spotify' || saved.has(a.id);
