import { useEffect } from 'react';
import { coverSrc } from '../api';
import { livePosition } from '../player/types';
import { currentItem, usePlayer } from '../store/player';

/** Lock-screen / hardware-key controls for the browser zone, wired to the player store. */
export function MediaSessionBridge() {
  const state = usePlayer((s) => s.state);
  const zones = usePlayer((s) => s.zones);
  const command = usePlayer((s) => s.command);
  const kind = zones.find((z) => z.id === state.zone)?.kind;
  const cur = currentItem(state);
  const active = kind === 'browser' && 'mediaSession' in navigator;

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    if (!cur) { ms.metadata = null; ms.playbackState = 'none'; return; }
    ms.metadata = new MediaMetadata({
      title: cur.track.title,
      artist: cur.track.artists.map((a) => a.name).join(', '),
      album: cur.album.title,
      artwork: [{ src: new URL(coverSrc(cur.album, 600), location.href).href, sizes: '600x600' }],
    });
  }, [active, cur?.track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    ms.playbackState = state.status === 'playing' ? 'playing' : state.status === 'paused' ? 'paused' : 'none';
    try {
      if (cur && cur.track.durationMs > 0) ms.setPositionState({ duration: cur.track.durationMs / 1000, position: livePosition(state) / 1000, playbackRate: 1 });
    } catch { /* invalid state while loading */ }
  }, [active, state.status, state.updatedAt, cur?.track.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported */ } };
    set('play', () => void command({ type: 'resume' }));
    set('pause', () => void command({ type: 'pause' }));
    set('previoustrack', () => void command({ type: 'prev' }));
    set('nexttrack', () => void command({ type: 'next' }));
    set('seekto', (d) => { if (d.seekTime !== undefined) void command({ type: 'seek', positionMs: d.seekTime * 1000 }); });
    set('seekbackward', () => void command({ type: 'seek', positionMs: Math.max(0, livePosition(usePlayer.getState().state) - 10_000) }));
    set('seekforward', () => void command({ type: 'seek', positionMs: livePosition(usePlayer.getState().state) + 10_000 }));
    return () => (['play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward'] as const).forEach((a) => set(a, null));
  }, [active, command]);

  return null;
}
