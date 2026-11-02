import type { Track } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { sdkSupportedFor } from '../lib/device';
import type { PlayItem, ZoneInfo } from '../lib/types';
import { cantPlayMessage, playableZones, routeItems, spotifyDeepLink, withoutOwnDevice, withoutPcDevice, zoneCanPlay } from './routing';

const t = (id: string, source: 'local' | 'spotify', albumId = source === 'spotify' ? 'sp:alb1' : 'la:a'): PlayItem => ({
  track: { id, albumId, source, title: id, artists: [], disc: 1, number: 1, durationMs: 1000 } as Track,
  album: { id: albumId, title: 'T' },
});
const radio = (id = 'rs:station-1'): PlayItem => ({
  track: { id, albumId: id, source: 'radio', title: id, artists: [], disc: 1, number: 1, durationMs: 0 } as unknown as Track,
  album: { id, title: 'Station' },
});
const ZONES: ZoneInfo[] = [
  { id: 'pc', name: 'Linux PC speakers', kind: 'pc' },
  { id: 'spotify:phone', name: 'iPhone', kind: 'spotify' },
  { id: 'browser', name: 'This Mac', kind: 'browser' },
];
const SDK = { sdk: true }, NO_SDK = { sdk: false };

describe('zoneCanPlay', () => {
  it('pc is local-only, Connect is spotify-only, browser is local + (spotify via SDK)', () => {
    expect(zoneCanPlay('pc', 'local', SDK)).toBe(true);
    expect(zoneCanPlay('pc', 'spotify', SDK)).toBe(false);
    expect(zoneCanPlay('spotify', 'spotify', NO_SDK)).toBe(true);
    expect(zoneCanPlay('spotify', 'local', SDK)).toBe(false);
    expect(zoneCanPlay('browser', 'local', NO_SDK)).toBe(true);
    expect(zoneCanPlay('browser', 'spotify', NO_SDK)).toBe(false);
    expect(zoneCanPlay('browser', 'spotify', SDK)).toBe(true);
  });
});

describe('internet radio', () => {
  it('plays on the PC and in this browser, never on a Connect device', () => {
    expect(zoneCanPlay('pc', 'radio', NO_SDK)).toBe(true);
    expect(zoneCanPlay('browser', 'radio', NO_SDK)).toBe(true);
    expect(zoneCanPlay('spotify', 'radio', SDK)).toBe(false);
  });
  it('routes a station without dropping it', () => {
    const r = routeItems('pc', [radio()], 0, NO_SDK);
    expect(r.ok && r.dropped).toBe(0);
    expect(r.ok && r.items[0]!.track.id).toBe('rs:station-1');
  });
  it('asks for another zone when the current one cannot play radio', () => {
    expect(routeItems('spotify', [radio()], 0, SDK)).toMatchObject({ ok: false, need: 'radio' });
  });
  it('offers the PC and browser as radio targets', () => {
    expect(playableZones(ZONES, 'radio', SDK).map((o) => o.zone.id)).toEqual(['browser', 'pc']);
  });
  it('explains why a Connect device cannot play a station', () => {
    expect(cantPlayMessage({ kind: 'spotify', name: 'iPhone' }, 'radio')).toContain('internet radio');
  });
});

describe('routeItems', () => {
  it('asks when the start item cannot play', () => {
    const r = routeItems('pc', [t('sp:1', 'spotify')], 0, SDK);
    expect(r).toEqual({ ok: false, reason: 'start', need: 'spotify' });
  });
  it('drops unplayable items and re-bases the start index', () => {
    const items = [t('l:1', 'local'), t('sp:1', 'spotify'), t('l:2', 'local')];
    const r = routeItems('pc', items, 2, SDK);
    expect(r.ok && r.items.map((i) => i.track.id)).toEqual(['l:1', 'l:2']);
    expect(r.ok && r.startIndex).toBe(1);
    expect(r.ok && r.dropped).toBe(1);
  });
  it('keeps everything on the hybrid browser zone', () => {
    const items = [t('l:1', 'local'), t('sp:1', 'spotify')];
    const r = routeItems('browser', items, 1, SDK);
    expect(r.ok && r.dropped).toBe(0);
  });
  it('local items on a Connect device need a choice', () => {
    expect(routeItems('spotify', [t('l:1', 'local')], 0, SDK)).toMatchObject({ ok: false, need: 'local' });
  });
});

describe('playableZones', () => {
  it('lists the browser first (labelled), then Connect devices, only when the SDK works', () => {
    const o = playableZones(ZONES, 'spotify', SDK);
    expect(o.map((x) => x.zone.id)).toEqual(['browser', 'spotify:phone']);
    expect(o[0]!.label).toBe('This Mac (Spotify)');
    expect(playableZones(ZONES, 'spotify', NO_SDK).map((x) => x.zone.id)).toEqual(['spotify:phone']);
  });
  it('local tracks: pc + browser', () => {
    expect(playableZones(ZONES, 'local', SDK).map((x) => x.zone.id)).toEqual(['browser', 'pc']);
  });
});

describe('withoutOwnDevice', () => {
  it('hides the SDK device that shows up as a Connect zone (by id or name)', () => {
    const z: ZoneInfo[] = [...ZONES, { id: 'spotify:abc', name: 'rune — This Mac', kind: 'spotify' }, { id: 'spotify:other', name: 'rune — Laptop', kind: 'spotify' }];
    expect(withoutOwnDevice(z, { name: 'rune — This Mac', deviceId: null }).map((x) => x.id)).not.toContain('spotify:abc');
    expect(withoutOwnDevice(z, { name: 'nope', deviceId: 'abc' }).map((x) => x.id)).not.toContain('spotify:abc');
    expect(withoutOwnDevice(z, { name: 'rune — This Mac', deviceId: 'abc' }).map((x) => x.id)).toContain('spotify:other');
  });
});

describe('spotifyDeepLink', () => {
  it('album when all items share an album, else the track, else null; explicit context wins', () => {
    expect(spotifyDeepLink([t('sp:1', 'spotify'), t('sp:2', 'spotify')])).toBe('spotify:album:alb1');
    expect(spotifyDeepLink([t('sp:1', 'spotify', 'sp:x'), t('sp:2', 'spotify', 'sp:y')])).toBe('spotify:track:1');
    expect(spotifyDeepLink([t('l:1', 'local')])).toBeNull();
    expect(spotifyDeepLink([t('sp:1', 'spotify')], 'spotify:playlist:zzz')).toBe('spotify:playlist:zzz');
  });
});

describe('sdkSupportedFor', () => {
  const desktop = { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17 Safari/605.1.15', touchPoints: 0, secure: true, hasEme: true };
  it('desktop browsers on a secure context with EME', () => {
    expect(sdkSupportedFor(desktop)).toBe(true);
    expect(sdkSupportedFor({ ...desktop, secure: false })).toBe(false);
    expect(sdkSupportedFor({ ...desktop, hasEme: false })).toBe(false);
  });
  it('not iPhone / iPad / iPadOS-as-Mac / Android', () => {
    expect(sdkSupportedFor({ ...desktop, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' })).toBe(false);
    expect(sdkSupportedFor({ ...desktop, touchPoints: 5 })).toBe(false);
    expect(sdkSupportedFor({ ...desktop, ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36' })).toBe(false);
  });
});

describe('pc zone with the PC’s Spotify app', () => {
  const PC: ZoneInfo = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyDeviceId: 'abc123', spotifyDeviceName: 'HORSE' };
  it('plays Spotify only when the app is there', () => {
    expect(zoneCanPlay(PC, 'spotify', NO_SDK)).toBe(true);
    expect(zoneCanPlay(PC, 'local', NO_SDK)).toBe(true);
    expect(zoneCanPlay({ ...PC, spotifyDeviceId: undefined }, 'spotify', SDK)).toBe(false);
    expect(zoneCanPlay('pc', 'spotify', SDK)).toBe(false);
  });
  it('keeps a mixed list intact on the hybrid pc zone', () => {
    const r = routeItems(PC, [t('l:1', 'local'), t('sp:1', 'spotify')], 1, NO_SDK);
    expect(r.ok && r.dropped).toBe(0);
  });
  it('lists the pc zone as a Spotify target and hides its duplicate Connect device', () => {
    const zones: ZoneInfo[] = [PC, { id: 'spotify:abc123', name: 'HORSE', kind: 'spotify' }, { id: 'spotify:phone', name: 'iPhone', kind: 'spotify' }];
    expect(withoutPcDevice(zones).map((z) => z.id)).toEqual(['pc', 'spotify:phone']);
    expect(playableZones(withoutPcDevice(zones), 'spotify', NO_SDK).map((o) => o.zone.id)).toEqual(['spotify:phone', 'pc']);
  });
  it('gives an actionable message when the app is missing', () => {
    expect(cantPlayMessage({ kind: 'pc', name: 'Linux PC speakers' }, 'spotify')).toBe('Open the Spotify app on the PC to play Spotify through the Linux speakers');
    expect(cantPlayMessage({ kind: 'spotify', name: 'iPhone' }, 'local')).toContain('iPhone');
  });
});
