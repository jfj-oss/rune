import type { Source } from '@liner/shared';
import type { PlayItem, ZoneInfo } from '../lib/types';

/** What this client can currently do beyond plain local playback. */
export interface Caps {
  /** Spotify is connected AND the Web Playback SDK can run here (desktop browser, premium). */
  sdk: boolean;
}

/** Can a zone of this kind play an item of this source? */
export function zoneCanPlay(kind: ZoneInfo['kind'], source: Source, caps: Caps): boolean {
  if (kind === 'pc') return source === 'local';
  if (kind === 'browser') return source === 'local' || caps.sdk;
  return source === 'spotify'; // Spotify Connect device
}

export type Routing =
  | { ok: true; items: PlayItem[]; startIndex: number; dropped: number }
  | { ok: false; reason: 'start'; need: Source };

/**
 * Decide what a zone can take from a list. If the item at `startIndex` cannot play there, the caller must
 * ask the user (the "Play on…" sheet); otherwise unplayable items are dropped from the list.
 */
export function routeItems(kind: ZoneInfo['kind'], items: PlayItem[], startIndex: number, caps: Caps): Routing {
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
    if (!zoneCanPlay(z.kind, source, caps)) continue;
    out.push({ zone: z, label: z.kind === 'browser' && source === 'spotify' ? `${z.name} (Spotify)` : z.name });
  }
  const rank = (z: ZoneInfo) => (z.kind === 'browser' ? 0 : z.kind === 'spotify' ? 1 : 2);
  return out.sort((a, b) => rank(a.zone) - rank(b.zone));
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
