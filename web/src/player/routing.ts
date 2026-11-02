import type { Source } from '@liner/shared';
import type { PlayItem, ZoneInfo } from '../lib/types';

/** What this client can currently do beyond plain local playback. */
export interface Caps {
  /** Spotify is connected AND the Web Playback SDK can run here (desktop browser, premium). */
  sdk: boolean;
}

/** A zone, or just its kind (a pc zone then has no Spotify app). */
export type ZoneLike = ZoneInfo['kind'] | Pick<ZoneInfo, 'kind' | 'spotifyDeviceId'>;
const kindOf = (z: ZoneLike): ZoneInfo['kind'] => (typeof z === 'string' ? z : z.kind);

/** Does this pc zone have the Spotify desktop app next to it (so it can play Spotify tracks)? */
export const pcHasSpotify = (z: ZoneLike): boolean => typeof z !== 'string' && z.kind === 'pc' && !!z.spotifyDeviceId;

/** Can a zone play an item of this source? */
export function zoneCanPlay(zone: ZoneLike, source: Source, caps: Caps): boolean {
  const kind = kindOf(zone);
  if (kind === 'pc') return source === 'local' || pcHasSpotify(zone);
  if (kind === 'browser') return source === 'local' || caps.sdk;
  return source === 'spotify'; // Spotify Connect device
}

/** The actionable text for "this zone can't play <source>". */
export function cantPlayMessage(zone: Pick<ZoneInfo, 'kind' | 'name'>, source: Source): string {
  if (zone.kind === 'pc' && source === 'spotify') return 'Open the Spotify app on the PC to play Spotify through the Linux speakers';
  return `${zone.name} can’t play ${source === 'spotify' ? 'Spotify' : 'local'} tracks`;
}

export type Routing =
  | { ok: true; items: PlayItem[]; startIndex: number; dropped: number }
  | { ok: false; reason: 'start'; need: Source };

/**
 * Decide what a zone can take from a list. If the item at `startIndex` cannot play there, the caller must
 * ask the user (the "Play on…" sheet); otherwise unplayable items are dropped from the list.
 */
export function routeItems(kind: ZoneLike, items: PlayItem[], startIndex: number, caps: Caps): Routing {
  const start = items[startIndex];
  if (!start) return { ok: true, items: [], startIndex: 0, dropped: 0 };
  if (!zoneCanPlay(kind, start.track.source, caps)) return { ok: false, reason: 'start', need: start.track.source };
  const kept = items.filter((i) => zoneCanPlay(kind, i.track.source, caps));
  return { ok: true, items: kept, startIndex: Math.max(0, kept.indexOf(start)), dropped: items.length - kept.length };
}

export interface ZoneOption {
  zone: ZoneInfo;
  /** Label to show in the sheet. */
  label: string;
}

/** Zones that could play items of this source, in display order (browser first, then Connect devices). */
export function playableZones(zones: ZoneInfo[], source: Source, caps: Caps): ZoneOption[] {
  const out: ZoneOption[] = [];
  for (const z of zones) {
    if (!zoneCanPlay(z, source, caps)) continue;
    out.push({ zone: z, label: z.kind === 'browser' && source === 'spotify' ? `${z.name} (Spotify)` : z.name });
  }
  const rank = (z: ZoneInfo) => (z.kind === 'browser' ? 0 : z.kind === 'spotify' ? 1 : 2);
  return out.sort((a, b) => rank(a.zone) - rank(b.zone));
}

/** The PC's Spotify app is folded into the pc zone, so it must not show up a second time as a Connect device. */
export function withoutPcDevice(zones: ZoneInfo[]): ZoneInfo[] {
  const hidden = new Set(zones.filter((z) => z.kind === 'pc' && z.spotifyDeviceId).map((z) => `spotify:${z.spotifyDeviceId}`));
  return hidden.size ? zones.filter((z) => !(z.kind === 'spotify' && hidden.has(z.id))) : zones;
}

/** rune's own Web Playback SDK device also shows up in /api/zones as a Connect device: hide that duplicate. */
export function withoutOwnDevice(zones: ZoneInfo[], own: { name: string; deviceId?: string | null }): ZoneInfo[] {
  return zones.filter((z) => !(z.kind === 'spotify' && ((own.deviceId && z.id === `spotify:${own.deviceId}`) || z.name === own.name)));
}

/** Deep link that opens the item in the Spotify app (which then shows up as a Connect device). */
export function spotifyDeepLink(items: PlayItem[], context?: string): string | null {
  if (context) return context;
  const first = items[0];
  if (!first || first.track.source !== 'spotify') return null;
  const album = first.album.id;
  if (album.startsWith('sp:') && items.every((i) => i.album.id === album)) return `spotify:album:${album.slice(3)}`;
  const uri = first.track.spotifyUri ?? (first.track.id.startsWith('sp:') ? `spotify:track:${first.track.id.slice(3)}` : null);
  return uri;
}
