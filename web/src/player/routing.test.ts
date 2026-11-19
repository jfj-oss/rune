import type { Track } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import type { PlayItem, ZoneInfo } from '../lib/types';
import { cantPlayMessage, playableZones, routeItems, spotifyDeepLink, spotifyDeviceHint, withoutPcDevice, zoneCanPlay, followPcSpeakers, noteSounding } from './routing';

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
/** A phone that hears Spotify through Soloist, and a browser that plays none. */
const SOLOIST = { soloist: true }, NONE = {};

describe('zoneCanPlay', () => {
  it('pc can host any source (it starts Spotify on demand), Connect is spotify-only, browser is local + (spotify only via Soloist on a phone)', () => {
    expect(zoneCanPlay('pc', 'local', SOLOIST)).toBe(true);
    expect(zoneCanPlay('pc', 'spotify', SOLOIST)).toBe(true); // rune starts the desktop app
    expect(zoneCanPlay('spotify', 'spotify', NONE)).toBe(true);
    expect(zoneCanPlay('spotify', 'local', SOLOIST)).toBe(false);
    expect(zoneCanPlay('browser', 'local', NONE)).toBe(true);
    expect(zoneCanPlay('browser', 'spotify', NONE)).toBe(false);
    expect(zoneCanPlay('browser', 'spotify', SOLOIST)).toBe(true);
  });
});

describe('internet radio', () => {
  it('plays on the PC and in this browser, never on a Connect device', () => {
    expect(zoneCanPlay('pc', 'radio', NONE)).toBe(true);
    expect(zoneCanPlay('browser', 'radio', NONE)).toBe(true);
    expect(zoneCanPlay('spotify', 'radio', SOLOIST)).toBe(false);
  });
  it('routes a station without dropping it', () => {
    const r = routeItems('pc', [radio()], 0, NONE);
    expect(r.ok && r.dropped).toBe(0);
    expect(r.ok && r.items[0]!.track.id).toBe('rs:station-1');
  });
  it('asks for another zone when the current one cannot play radio', () => {
    expect(routeItems('spotify', [radio()], 0, SOLOIST)).toMatchObject({ ok: false, need: 'radio' });
  });
  it('offers the PC and browser as radio targets', () => {
    expect(playableZones(ZONES, 'radio', SOLOIST).map((o) => o.zone.id)).toEqual(['browser', 'pc']);
  });
  it('explains why a Connect device cannot play a station', () => {
    expect(cantPlayMessage({ kind: 'spotify', name: 'iPhone' }, 'radio')).toContain('internet radio');
  });
});

describe('routeItems', () => {
  it('asks when the start item cannot play', () => {
    const r = routeItems('browser', [t('sp:1', 'spotify')], 0, NONE);
    expect(r).toEqual({ ok: false, reason: 'start', need: 'spotify' });
  });
  it('drops unplayable items and re-bases the start index', () => {
    const items = [t('l:1', 'local'), t('sp:1', 'spotify'), t('l:2', 'local')];
    const r = routeItems('browser', items, 2, NONE);
    expect(r.ok && r.items.map((i) => i.track.id)).toEqual(['l:1', 'l:2']);
    expect(r.ok && r.startIndex).toBe(1);
    expect(r.ok && r.dropped).toBe(1);
  });
  it('keeps everything on the hybrid browser zone', () => {
    const items = [t('l:1', 'local'), t('sp:1', 'spotify')];
    const r = routeItems('browser', items, 1, SOLOIST);
    expect(r.ok && r.dropped).toBe(0);
  });
  it('local items on a Connect device need a choice', () => {
    expect(routeItems('spotify', [t('l:1', 'local')], 0, SOLOIST)).toMatchObject({ ok: false, need: 'local' });
  });
});

describe('playableZones', () => {
  it('lists the browser first (labelled), then Connect devices, then the PC (it starts Spotify itself)', () => {
    const o = playableZones(ZONES, 'spotify', SOLOIST);
    expect(o.map((x) => x.zone.id)).toEqual(['browser', 'spotify:phone', 'pc']);
    expect(o[0]!.label).toBe('This Mac');
    expect(playableZones(ZONES, 'spotify', NONE).map((x) => x.zone.id)).toEqual(['spotify:phone', 'pc']);
  });
  it('local tracks: pc + browser', () => {
    expect(playableZones(ZONES, 'local', SOLOIST).map((x) => x.zone.id)).toEqual(['browser', 'pc']);
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

describe('pc zone with the PC’s Spotify app', () => {
  const PC: ZoneInfo = { id: 'pc', name: 'Linux PC speakers', kind: 'pc', spotifyDeviceId: 'abc123', spotifyDeviceName: 'MYPC' };
  it('plays Spotify with the app there, and rune starts it when it is missing', () => {
    expect(zoneCanPlay(PC, 'spotify', NONE)).toBe(true);
    expect(zoneCanPlay(PC, 'local', NONE)).toBe(true);
    expect(zoneCanPlay({ ...PC, spotifyDeviceId: undefined }, 'spotify', SOLOIST)).toBe(true);
    expect(zoneCanPlay('pc', 'spotify', SOLOIST)).toBe(true);
  });
  it('keeps a mixed list intact on the hybrid pc zone', () => {
    const r = routeItems(PC, [t('l:1', 'local'), t('sp:1', 'spotify')], 1, NONE);
    expect(r.ok && r.dropped).toBe(0);
  });
  it('lists the pc zone as a Spotify target and hides its duplicate Connect device', () => {
    const zones: ZoneInfo[] = [PC, { id: 'spotify:abc123', name: 'MYPC', kind: 'spotify' }, { id: 'spotify:phone', name: 'iPhone', kind: 'spotify' }];
    expect(withoutPcDevice(zones).map((z) => z.id)).toEqual(['pc', 'spotify:phone']);
    expect(playableZones(withoutPcDevice(zones), 'spotify', NONE).map((o) => o.zone.id)).toEqual(['spotify:phone', 'pc']);
  });
  it('explains that rune starts the app (no manual “open Spotify” instruction)', () => {
    expect(cantPlayMessage({ kind: 'pc', name: 'Linux PC speakers' }, 'spotify')).toBe('rune starts Spotify on the PC for this');
    expect(cantPlayMessage({ kind: 'spotify', name: 'iPhone' }, 'local')).toContain('iPhone');
  });
});

describe('Connect device labels', () => {
  it('says plainly that a phone is the Spotify app on a phone', () => {
    expect(spotifyDeviceHint({ name: 'iPhone', deviceType: 'Smartphone' })).toBe('Spotify app on a phone');
    expect(spotifyDeviceHint({ name: 'Pixel', deviceType: 'smartphone' })).toBe('Spotify app on a phone');
    expect(spotifyDeviceHint({ name: 'Living room', deviceType: 'Speaker' })).toBe('Spotify speaker');
    expect(spotifyDeviceHint({ name: 'MYPC', deviceType: 'Computer' })).toBe('Spotify app on a computer');
  });

  it('falls back to the name when Spotify gives no type', () => {
    expect(spotifyDeviceHint({ name: 'Jo’s iPhone' })).toBe('Spotify app on a phone');
    expect(spotifyDeviceHint({ name: 'Kitchen' })).toBe('Spotify Connect');
  });

  it('says when a device is asleep or restricted', () => {
    expect(spotifyDeviceHint({ name: 'iPhone', deviceType: 'Smartphone', isActive: false }))
      .toBe('Spotify app on a phone · asleep — open Spotify there to wake it');
    expect(spotifyDeviceHint({ name: 'iPhone', deviceType: 'Smartphone', isRestricted: true }))
      .toBe('Spotify app on a phone · restricted — pick another device');
    expect(spotifyDeviceHint({ name: 'iPhone', deviceType: 'Smartphone', isActive: true }))
      .toBe('Spotify app on a phone');
  });
});

describe('Spotify in a browser that has no way to play it', () => {
  it('tells the user to hand it to the Spotify app, which then shows as a zone', () => {
    expect(cantPlayMessage({ kind: 'browser', name: 'iPhone' }, 'spotify')).toBe(
      'Spotify songs play on the PC or your phone’s Spotify',
    );
  });
});

describe('followPcSpeakers', () => {
  const pc = { id: 'pc', spotifyDeviceId: 'dev' };
  const idle = { zone: 'browser', status: 'stopped' };
  it('shows the PC when something else starts it while this page is idle', () => {
    expect(followPcSpeakers({ zone: 'pc', status: 'playing' }, false, idle, pc)).toBe(true);
    expect(followPcSpeakers({ zone: 'spotify:dev', status: 'playing' }, false, idle, pc)).toBe(true);
  });
  it('leaves a page that is playing, or was moved away from a playing PC', () => {
    expect(followPcSpeakers({ zone: 'pc', status: 'playing' }, false, { zone: 'browser', status: 'playing' }, pc)).toBe(false);
    expect(followPcSpeakers({ zone: 'pc', status: 'playing' }, true, idle, pc)).toBe(false);
  });
  it('ignores other zones and pauses', () => {
    expect(followPcSpeakers({ zone: 'spotify:other', status: 'playing' }, false, idle, pc)).toBe(false);
    expect(followPcSpeakers({ zone: 'pc', status: 'paused' }, false, idle, pc)).toBe(false);
    expect(followPcSpeakers({ zone: 'pc', status: 'playing' }, false, { zone: 'pc', status: 'stopped' }, pc)).toBe(false);
  });
});

describe('following the PC speakers through a run of events', () => {
  const pc = { id: 'pc', spotifyDeviceId: 'dev' };
  const idle = { zone: 'browser', status: 'paused' };
  /** Replays zone events the way the store does; returns how many times the page would follow. */
  const follows = (events: [string, string][]) => {
    const seen = new Map<string, boolean>();
    return events.filter(([zone, status]) => followPcSpeakers({ zone, status }, noteSounding(seen, { zone, status }), idle, pc)).length;
  };

  it('the first event is not a start: a song already playing when the page opened', () => {
    expect(follows([['pc', 'playing']])).toBe(0);
    expect(follows([['spotify:dev', 'playing'], ['spotify:dev', 'playing']])).toBe(0);
  });
  it('mpv going through loading to the next track is not a start', () => {
    expect(follows([['pc', 'playing'], ['pc', 'loading'], ['pc', 'playing'], ['pc', 'loading'], ['pc', 'playing']])).toBe(0);
  });
  it('a new song on mpv from idle is a start, and only one', () => {
    expect(follows([['pc', 'stopped'], ['pc', 'loading'], ['pc', 'playing']])).toBe(1);
    expect(follows([['pc', 'paused'], ['pc', 'loading'], ['pc', 'playing']])).toBe(1);
    expect(follows([['pc', 'loading'], ['pc', 'playing']])).toBe(1); // no event since the page opened
  });
  it('resuming is a start on either player', () => {
    expect(follows([['pc', 'paused'], ['pc', 'playing']])).toBe(1);
    expect(follows([['spotify:dev', 'paused'], ['spotify:dev', 'playing']])).toBe(1);
  });
});
