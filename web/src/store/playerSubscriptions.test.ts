import type { PlayerState } from '@liner/shared';
import { describe, expect, it } from 'vitest';
import { emptyState } from '../player/types';
import { currentItem, usePlayer } from './player';

/** Build a state with two queue items. Position/updatedAt are the only fields a tick changes. */
function baseState(pos = 0): PlayerState {
  const item = (id: string, albumId: string) => ({
    queueId: `q:${id}`,
    track: { id, albumId, source: 'local' as const, title: id, artists: [{ id: 'ar:1', name: 'A' }], disc: 1, number: 1, durationMs: 200_000 },
    album: { id: albumId, title: 'Album' },
  });
  return {
    ...emptyState('browser'),
    status: 'playing',
    queue: [item('t:1', 'la:one'), item('t:2', 'la:two')],
    index: 0,
    positionMs: pos,
    updatedAt: 1_000,
  };
}

// The selectors the two lists use (Discover rows and the album TrackList).
const discoverCurId = (s: { state: PlayerState }) => currentItem(s.state)?.track.id;
const trackListCurId = (albumId: string) => (s: { state: PlayerState }) => {
  const cur = currentItem(s.state);
  return cur && cur.album.id === albumId ? cur.track.id : undefined;
};
const status = (s: { state: PlayerState }) => s.state.status;

type StoreState = ReturnType<typeof usePlayer.getState>;

/** Count selector changes the way useSyncExternalStore does (Object.is), i.e. the component's re-renders. */
function renders<T>(selector: (s: StoreState) => T) {
  let n = 0;
  let prev = selector(usePlayer.getState());
  const off = usePlayer.subscribe((s) => {
    const next = selector(s);
    if (!Object.is(prev, next)) { prev = next; n++; }
  });
  return { get: () => n, off };
}

describe('narrow player subscriptions', () => {
  it('a position-only update does not re-render Discover or an album tracklist', () => {
    usePlayer.setState({ state: baseState(0) });
    const discover = renders(discoverCurId);
    const trackList = renders(trackListCurId('la:one'));
    const transport = renders(status);
    const broad = renders((s) => s.state); // what the old code subscribed to, as a control
    try {
      usePlayer.setState({ state: baseState(5_000) });
      usePlayer.setState({ state: baseState(6_000) });

      expect(broad.get()).toBe(2);
      expect(discover.get()).toBe(0);
      expect(trackList.get()).toBe(0);
      expect(transport.get()).toBe(0);
    } finally {
      discover.off(); trackList.off(); transport.off(); broad.off();
    }
  });

  it('still re-renders the lists when the current track or transport status changes', () => {
    usePlayer.setState({ state: baseState(0) });
    const discover = renders(discoverCurId);
    const trackList = renders(trackListCurId('la:one'));
    const transport = renders(status);
    try {
      usePlayer.setState({ state: { ...baseState(0), index: 1 } });
      expect(discover.get()).toBe(1);
      expect(trackList.get()).toBe(1); // the album's track is no longer current
      expect(transport.get()).toBe(0);

      usePlayer.setState({ state: { ...baseState(0), index: 1, status: 'paused' } });
      expect(transport.get()).toBe(1);
    } finally {
      discover.off(); trackList.off(); transport.off();
    }
  });
});
