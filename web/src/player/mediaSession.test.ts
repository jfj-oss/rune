// The lock-screen card and controls (player/mediaSession.ts), for the browser zone — on a phone that includes Spotify
// songs heard through Soloist on the PC.
import type { PlayerState, QueueItem } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { mediaActions, mediaMetadataFor, mediaPlaybackStateFor, mediaPositionFor } from './mediaSession';

const song: QueueItem = {
  queueId: 'q1',
  track: { id: 'sp:abc', albumId: 'sp:alb', source: 'spotify', title: 'Givin’ It All', artists: [{ id: 'sp:a1', name: 'Someone' }, { id: 'sp:a2', name: 'Else' }], disc: 1, number: 1, durationMs: 200_000, spotifyUri: 'spotify:track:abc' },
  album: { id: 'sp:alb', title: 'An Album', coverUrl: 'https://i.scdn.co/image/x' },
};
const state = (patch: Partial<PlayerState> = {}): PlayerState => ({ zone: 'browser', status: 'playing', queue: [song], index: 0, positionMs: 10_000, volume: 60, shuffle: false, repeat: 'off', updatedAt: 1_000, ...patch });

describe('media session', () => {
  it('names the Spotify song playing on the phone through Soloist: title, artists, album, 600 px cover as an absolute URL', () => {
    const meta = mediaMetadataFor(song, (album, size) => `/api/cover/${album.id}?size=${size}`, 'https://rune.example/albums');
    expect(meta).toEqual({ title: 'Givin’ It All', artist: 'Someone, Else', album: 'An Album', artwork: [{ src: 'https://rune.example/api/cover/sp:alb?size=600', sizes: '600x600' }] });
    expect(mediaMetadataFor(undefined, () => '', 'https://rune.example/')).toBeNull();
  });

  it('the card follows a placeholder being named: new title, new artwork', () => {
    const placeholder = { ...song, track: { ...song.track, title: '', artists: [] }, album: { id: 'sp:unknown', title: '' } };
    const before = mediaMetadataFor(placeholder, (a, s) => `/c/${a.id}/${s}`, 'https://r.example/');
    const after = mediaMetadataFor(song, (a, s) => `/c/${a.id}/${s}`, 'https://r.example/');
    expect(before?.title).toBe('');
    expect(after?.title).toBe('Givin’ It All');
    expect(after?.artwork[0]?.src).not.toBe(before?.artwork[0]?.src);
  });

  it('playing and loading show the Pause control; paused shows Play; stopped shows nothing', () => {
    expect(mediaPlaybackStateFor('playing')).toBe('playing');
    expect(mediaPlaybackStateFor('loading')).toBe('playing');
    expect(mediaPlaybackStateFor('paused')).toBe('paused');
    expect(mediaPlaybackStateFor('stopped')).toBe('none');
  });

  it('the position card runs with the live position and is left out while the length is unknown', () => {
    expect(mediaPositionFor(state(), 6_000)).toEqual({ duration: 200, position: 15, playbackRate: 1 });
    expect(mediaPositionFor(state({ status: 'paused' }), 6_000)).toEqual({ duration: 200, position: 10, playbackRate: 1 });
    expect(mediaPositionFor(state({ queue: [{ ...song, track: { ...song.track, durationMs: 0 } }] }))).toBeNull();
  });

  it('the lock-screen keys are rune’s own commands: play, pause, previous, next, ±10 s and seek-to', () => {
    const a = mediaActions(() => 25_000);
    expect(a.play()).toEqual({ type: 'resume' });
    expect(a.pause()).toEqual({ type: 'pause' });
    expect(a.previoustrack()).toEqual({ type: 'prev' });
    expect(a.nexttrack()).toEqual({ type: 'next' });
    expect(a.seekbackward()).toEqual({ type: 'seek', positionMs: 15_000 });
    expect(a.seekforward()).toEqual({ type: 'seek', positionMs: 35_000 });
    expect(a.seekto(90)).toEqual({ type: 'seek', positionMs: 90_000 });
    expect(mediaActions(() => 3_000).seekbackward()).toEqual({ type: 'seek', positionMs: 0 });
  });
});
