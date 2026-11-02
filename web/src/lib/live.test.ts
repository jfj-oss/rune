import type { PlayerState, QueueItem } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { liveMeta, liveSubtitle } from './live';

const cur = {
  queueId: 'q1',
  track: { id: 'rs:station-1', title: 'rs:station-1', artists: [] },
  album: { id: 'rs:station-1', title: 'Grid Lines FM' },
} as unknown as QueueItem;

const state = (nowPlaying?: PlayerState['nowPlaying']): PlayerState => ({ nowPlaying } as PlayerState);

describe('liveMeta', () => {
  it('falls back to the station when the stream sends no ICY metadata', () => {
    expect(liveMeta(state(), cur)).toEqual({ title: 'Grid Lines FM', artist: '', station: 'Grid Lines FM' });
  });
  it('prefers the ICY title, artist and station when the server has read them', () => {
    expect(liveMeta(state({ title: 'Blue in Green', artist: 'Miles Davis', station: 'Northlight Jazz' }), cur)).toEqual({
      title: 'Blue in Green',
      artist: 'Miles Davis',
      station: 'Northlight Jazz',
    });
  });
  it('trims ICY strings and keeps the station name from the queue item', () => {
    expect(liveMeta(state({ title: '  ', artist: '  ', station: '  Northlight Jazz  ' }), cur)).toEqual({
      title: 'Northlight Jazz',
      artist: '',
      station: 'Northlight Jazz',
    });
  });
  it('uses the current track title when there is no queue album', () => {
    const bare = { queueId: 'q', track: { id: 'rs:x', title: 'Live stream', artists: [] }, album: {} } as unknown as QueueItem;
    expect(liveMeta(state(), bare).station).toBe('Live stream');
  });
});

describe('liveSubtitle', () => {
  it('joins artist and station for compact rows', () => {
    expect(liveSubtitle(state({ title: 'Blue in Green', artist: 'Miles Davis', station: 'Northlight Jazz' }), cur)).toBe('Miles Davis · Northlight Jazz');
  });
  it('does not repeat the station when there is no ICY title', () => {
    expect(liveSubtitle(state(), cur)).toBe('Grid Lines FM');
  });
});
