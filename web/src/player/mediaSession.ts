// What the lock screen shows and does for the zone this page plays (components/MediaSession.tsx wires it to
// navigator.mediaSession). Pure, so the metadata of a Spotify song heard through Soloist on the phone, and the state the
// controls reflect, can be tested without a browser.
import type { PlayerState, QueueItem } from '@liner/shared';
import type { ExtCommand } from '../lib/types';
import { livePosition } from './types';

export interface MediaMetadataInit {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string }[];
}

/** The lock-screen card for the current song: title, artists, album, and the 600 px cover as an absolute URL. */
export function mediaMetadataFor(cur: QueueItem | undefined, coverUrl: (album: QueueItem['album'], size: 600) => string, base: string): MediaMetadataInit | null {
  if (!cur) return null;
  return {
    title: cur.track.title,
    artist: cur.track.artists.map((a) => a.name).join(', '),
    album: cur.album.title,
    artwork: [{ src: new URL(coverUrl(cur.album, 600), base).href, sizes: '600x600' }],
  };
}

export type MediaPlaybackState = 'none' | 'playing' | 'paused';

/** What the lock-screen controls show: `loading` counts as playing (a song on its way must not show a Play button). */
export function mediaPlaybackStateFor(status: PlayerState['status']): MediaPlaybackState {
  return status === 'playing' || status === 'loading' ? 'playing' : status === 'paused' ? 'paused' : 'none';
}

/** The position card, or null while the song's length is unknown (a Spotify placeholder before Soloist named it). */
export function mediaPositionFor(state: PlayerState, now = Date.now()): { duration: number; position: number; playbackRate: number } | null {
  const cur = state.queue[state.index];
  if (!cur || cur.track.durationMs <= 0) return null;
  const position = Math.min(cur.track.durationMs, livePosition(state, now));
  return { duration: cur.track.durationMs / 1000, position: position / 1000, playbackRate: 1 };
}

/** The lock-screen actions, each as the player command it sends (`position` reads the live position for the ±10 s keys). */
export function mediaActions(position: () => number): Record<'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'seekbackward' | 'seekforward', () => ExtCommand> & { seekto(seconds: number): ExtCommand } {
  return {
    play: () => ({ type: 'resume' }),
    pause: () => ({ type: 'pause' }),
    previoustrack: () => ({ type: 'prev' }),
    nexttrack: () => ({ type: 'next' }),
    seekbackward: () => ({ type: 'seek', positionMs: Math.max(0, position() - 10_000) }),
    seekforward: () => ({ type: 'seek', positionMs: position() + 10_000 }),
    seekto: (seconds) => ({ type: 'seek', positionMs: seconds * 1000 }),
  };
}
