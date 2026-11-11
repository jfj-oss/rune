import { useEffect } from 'react';
import { coverSrc } from '../api';
import { mediaActions, mediaMetadataFor, mediaPlaybackStateFor, mediaPositionFor } from '../player/mediaSession';
import { livePosition } from '../player/types';
import { currentItem, usePlayer } from '../store/player';

/**
 * Lock-screen / hardware-key controls for the browser zone, wired to the player store. On a phone that zone also plays
 * Spotify songs (Soloist on the PC, heard over the stream), so their title, artists and cover show on the lock screen too.
 */
export function MediaSessionBridge() {
  // Narrow subscriptions: the bridge only needs the track identity, transport status and position.
  const zone = usePlayer((s) => s.state.zone);
  const status = usePlayer((s) => s.state.status);
  const updatedAt = usePlayer((s) => s.state.updatedAt);
  const positionMs = usePlayer((s) => s.state.positionMs);
  const curId = usePlayer((s) => s.state.queue[s.state.index]?.track.id);
  // A Spotify placeholder is named (title, cover, length) a moment after it starts: the card follows.
  const curTitle = usePlayer((s) => s.state.queue[s.state.index]?.track.title);
  const curCover = usePlayer((s) => s.state.queue[s.state.index]?.album.coverUrl);
  const zones = usePlayer((s) => s.zones);
  const command = usePlayer((s) => s.command);
  const kind = zones.find((z) => z.id === zone)?.kind;
  const active = kind === 'browser' && 'mediaSession' in navigator;

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const meta = mediaMetadataFor(currentItem(usePlayer.getState().state), coverSrc, location.href);
    if (!meta) { ms.metadata = null; ms.playbackState = 'none'; return; }
    ms.metadata = new MediaMetadata(meta);
  }, [active, curId, curTitle, curCover]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const state = usePlayer.getState().state;
    ms.playbackState = mediaPlaybackStateFor(status);
    try {
      const pos = mediaPositionFor(state);
      if (pos) ms.setPositionState(pos);
    } catch { /* invalid state while loading */ }
  }, [active, status, updatedAt, positionMs, curId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
    const actions = mediaActions(() => livePosition(usePlayer.getState().state));
    set('play', () => void command(actions.play()));
    set('pause', () => void command(actions.pause()));
    set('previoustrack', () => void command(actions.previoustrack()));
    set('nexttrack', () => void command(actions.nexttrack()));
    set('seekto', (d) => { if (d.seekTime !== undefined) void command(actions.seekto(d.seekTime)); });
    set('seekbackward', () => void command(actions.seekbackward()));
    set('seekforward', () => void command(actions.seekforward()));
    return () => (['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'] as const).forEach((a) => set(a, null));
  }, [active, command]);

  return null;
}
