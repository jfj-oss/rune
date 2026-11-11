import type { PlayItem, PlaySource, ZoneInfo } from '../lib/types';

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
export function zoneCanPlay(zone: ZoneLike, source: PlaySource, caps: Caps): boolean {
  const kind = kindOf(zone);
  // The pc zone can host every source: local/radio through mpv, and Spotify through
  // the desktop app — which rune starts on demand (see player/pcStart.ts).
  if (kind === 'pc') return true;
  if (kind === 'browser') return source === 'local' || source === 'radio' || caps.sdk;
  return source === 'spotify'; // Spotify Connect device
}

/** The actionable text for "this zone can't play <source>". */
export function cantPlayMessage(zone: Pick<ZoneInfo, 'kind' | 'name'>, source: PlaySource): string {
  if (zone.kind === 'pc' && source === 'spotify') return 'rune starts Spotify on the PC for this';
  if (source === 'radio') return `${zone.name} can’t play internet radio — use the PC or this browser`;
  // iPhones/iPads (and any browser without the Web Playback SDK) cannot play Spotify inside the page.
  if (zone.kind === 'browser' && source === 'spotify') {
    return 'Spotify can’t play in this browser — open the Spotify app on this device, then pick it as the zone';
  }
  return `${zone.name} can’t play ${source === 'spotify' ? 'Spotify' : 'local'} tracks`;
}

/** A one-line description of a Connect device for the pickers, saying plainly what a phone is and whether it is asleep. */
export function spotifyDeviceHint(
  z: Pick<ZoneInfo, 'name' | 'deviceType' | 'isActive' | 'isRestricted' | 'soloist' | 'output' | 'problem'>,
): string {
  if (z.soloist) {
    if (z.problem) return `Spotify on the PC, no app · ${z.problem}`;
    return z.output === 'phone' ? 'Spotify on the PC, no app · streaming to the phone' : 'Spotify on the PC, no app · PC speakers';
  }
  const type = (z.deviceType ?? '').toLowerCase();
  const what =
    type === 'smartphone'
      ? 'Spotify app on a phone'
      : type === 'tablet'
        ? 'Spotify app on a tablet'
        : type === 'computer'
          ? 'Spotify app on a computer'
          : type === 'speaker'
            ? 'Spotify speaker'
            : !z.deviceType && /phone|iphone|ipad|android/i.test(z.name)
              ? 'Spotify app on a phone'
              : 'Spotify Connect';
  if (z.isRestricted) return `${what} · restricted — pick another device`;
  if (z.isActive === false) return `${what} · asleep — open Spotify there to wake it`;
  return what;
}

export type Routing =
  | { ok: true; items: PlayItem[]; startIndex: number; dropped: number }
  | { ok: false; reason: 'start'; need: PlaySource };

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
export function playableZones(zones: ZoneInfo[], source: PlaySource, caps: Caps): ZoneOption[] {
  const out: ZoneOption[] = [];
  for (const z of zones) {
    if (!zoneCanPlay(z, source, caps)) continue;
    out.push({ zone: z, label: z.kind === 'browser' && source === 'spotify' ? `${z.name} (Spotify)` : z.name });
  }
  // Soloist first among the Spotify zones: it needs no app anywhere and a phone can hear it.
  const rank = (z: ZoneInfo) => (z.kind === 'browser' ? 0 : z.soloist ? 1 : z.kind === 'spotify' ? 2 : 3);
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

/**
 * Note a zone's new status and return whether it was already sounding before. The first event from a zone says
 * nothing about a start, so it counts as "was already". 'loading' counts as sounding: mpv passes through it on every
 * new track, and that is not a start.
 */
export function noteSounding(seen: Map<string, boolean>, state: { zone: string; status: string }): boolean {
  const was = seen.get(state.zone) ?? state.status === 'playing';
  seen.set(state.zone, state.status === 'playing' || state.status === 'loading');
  return was;
}

/**
 * Something outside this page started the PC speakers (the voice assistant, another tab, the Spotify app) while this
 * page shows an idle zone: show the PC, or the music cannot be controlled from here. Only on a start, so a page moved
 * away from a playing PC stays where it was put. A start on mpv is seen at 'loading': it never reports 'playing' from
 * stopped directly.
 */
export function followPcSpeakers(
  event: { zone: string; status: string },
  wasPlaying: boolean,
  page: { zone: string; status: string },
  pc: Pick<ZoneInfo, 'id' | 'spotifyDeviceId'> | undefined,
): boolean {
  if (!pc || page.zone === pc.id || wasPlaying) return false;
  if (event.status !== 'playing' && event.status !== 'loading') return false;
  if (page.status === 'playing' || page.status === 'loading') return false;
  return event.zone === pc.id || (!!pc.spotifyDeviceId && event.zone === `spotify:${pc.spotifyDeviceId}`);
}
