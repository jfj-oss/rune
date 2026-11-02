import { isPlaceholderArtist } from './apply.js';
// Builds album credits from MusicBrainz release/recording/work relationships.
import type { MbArtist, MbRelation, MbRelease, MbTrack } from './mb.js';
import { titleCase } from './scoring.js';

export interface CollectedCredit {
  mbid: string;
  name: string;
  sortName?: string;
  role: string;
  /** null = whole album; otherwise local track ids. */
  trackIds: string[] | null;
}

const SIMPLE_ROLES: Record<string, string> = {
  producer: 'Producer',
  engineer: 'Engineer',
  mix: 'Mix',
  mixing: 'Mix',
  mastering: 'Mastering',
  'mastered by': 'Mastering',
  composer: 'Composer',
  lyricist: 'Lyricist',
};

function vocalRole(attributes: string[]): string {
  const joined = attributes.join(' ').toLowerCase();
  if (/background|backing/.test(joined)) return 'Background Vocals';
  return 'Lead Vocals';
}

function instrumentRole(attribute: string): string {
  const normalized = attribute.trim().toLowerCase();
  if (!normalized) return 'Performer';
  if (normalized === 'vocals' || normalized === 'lead vocals' || normalized === 'vocal') return 'Lead Vocals';
  if (/background vocal|backing vocal/.test(normalized)) return 'Background Vocals';
  return titleCase(attribute);
}

/** Roles contributed by a single MB relationship (empty = ignore it). */
export function rolesForRelation(relation: MbRelation): string[] {
  const type = relation.type.toLowerCase();
  const direct = SIMPLE_ROLES[type];
  if (direct) return [direct];

  if (type === 'vocal' || type === 'vocals') return [vocalRole(relation.attributes ?? [])];

  if (type === 'performer' || type === 'instrument' || type === 'instruments') {
    const attributes = relation.attributes ?? [];
    if (attributes.length === 0) return [];
    // Each attribute describes one instrument / vocal role.
    return attributes.map(instrumentRole);
  }

  return [];
}

interface MutableCredit {
  mbid: string;
  name: string;
  sortName?: string;
  role: string;
  /** null means "whole album" (found on the release or every track). */
  trackIds: Set<string> | null;
}

function artistInfo(artist: MbArtist): { mbid: string; name: string; sortName?: string } {
  return { mbid: artist.id, name: artist.name, sortName: artist['sort-name'] };
}

/**
 * Walk release-level, track-level, recording-level and work-level relationships
 * and return deduped credits. Recording-level credits carry the local track id.
 */
export function collectCredits(
  release: MbRelease,
  localTrackByRecordingId: Map<string, string>,
  albumTrackIds: string[],
): CollectedCredit[] {
  const byKey = new Map<string, MutableCredit>();
  const albumTrackSet = new Set(albumTrackIds);

  const add = (artist: MbArtist, role: string, trackId: string | null): void => {
    if (!artist.id || !role) return;
    const key = `${artist.id}|${role}`;
    const info = artistInfo(artist);
    let credit = byKey.get(key);
    if (!credit) {
      credit = {
        ...info,
        role,
        trackIds: trackId == null ? null : new Set([trackId]),
      };
      byKey.set(key, credit);
      return;
    }
    // A whole-album credit always wins.
    if (credit.trackIds === null) return;
    if (trackId == null) {
      credit.trackIds = null;
      return;
    }
    if (albumTrackSet.has(trackId)) credit.trackIds.add(trackId);
  };

  const processRelation = (relation: MbRelation, trackId: string | null): void => {
    if (relation.artist && !isPlaceholderArtist(relation.artist.id, relation.artist.name)) {
      for (const role of rolesForRelation(relation)) add(relation.artist, role, trackId);
    }
    // Composer / lyricist live on the work linked by a "performance" relation.
    for (const workRelation of relation.work?.relations ?? []) {
      if (!workRelation.artist || isPlaceholderArtist(workRelation.artist.id, workRelation.artist.name)) continue;
      const role = SIMPLE_ROLES[workRelation.type.toLowerCase()];
      if (role === 'Composer' || role === 'Lyricist') add(workRelation.artist, role, trackId);
    }
  };

  // Release-level credits (e.g. mastering).
  for (const relation of release.relations ?? []) processRelation(relation, null);

  const visitTrack = (track: MbTrack, recordingId: string | undefined): void => {
    const localTrackId = recordingId ? (localTrackByRecordingId.get(recordingId) ?? null) : null;
    for (const relation of track.relations ?? []) processRelation(relation, localTrackId);
    for (const relation of track.recording?.relations ?? []) processRelation(relation, localTrackId);
  };

  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) visitTrack(track, track.recording?.id);
  }

  const result: CollectedCredit[] = [];
  for (const credit of byKey.values()) {
    let trackIds: string[] | null = null;
    if (credit.trackIds !== null) {
      // Promote to whole-album when the role is present on every track.
      const coversAll = albumTrackIds.length > 0 && albumTrackIds.every((id) => credit.trackIds!.has(id));
      if (!coversAll) {
        trackIds = albumTrackIds.filter((id) => credit.trackIds!.has(id));
        // Include any ids not present in albumTrackIds (defensive).
        for (const id of credit.trackIds) if (!albumTrackIds.includes(id)) trackIds.push(id);
      }
    }
    result.push({ mbid: credit.mbid, name: credit.name, sortName: credit.sortName, role: credit.role, trackIds });
  }

  // Stable, useful ordering: whole-album credits first, then by role/name.
  result.sort((a, b) => {
    const aw = a.trackIds === null ? 0 : 1;
    const bw = b.trackIds === null ? 0 : 1;
    if (aw !== bw) return aw - bw;
    if (a.role !== b.role) return a.role.localeCompare(b.role);
    return a.name.localeCompare(b.name);
  });
  return result;
}
