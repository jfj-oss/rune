import { useEffect } from 'react';
import { coverSrc } from '../api';
import { livePosition } from '../player/types';
import { currentItem, usePlayer } from '../store/player';
import { usePhoneStream } from '../store/phoneStream';

/** Lock-screen / hardware-key controls for the browser zone, wired to the player store. */
export function MediaSessionBridge() {
  // Narrow subscriptions: the bridge only needs the track identity, transport status and position.
  const zone = usePlayer((s) => s.state.zone);
  const status = usePlayer((s) => s.state.status);
  const updatedAt = usePlayer((s) => s.state.updatedAt);
  const positionMs = usePlayer((s) => s.state.positionMs);
  const curId = usePlayer((s) => s.state.queue[s.state.index]?.track.id);
  const zones = usePlayer((s) => s.zones);
  const command = usePlayer((s) => s.command);
  const kind = zones.find((z) => z.id === zone)?.kind;
  // The browser zone plays here; so does the Soloist zone while this phone listens to its stream.
  const listening = usePhoneStream((s) => s.listening);
  const active = (kind === 'browser' || listening) && 'mediaSession' in navigator;

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const cur = currentItem(usePlayer.getState().state);
    if (!cur) { ms.metadata = null; ms.playbackState = 'none'; return; }
    ms.metadata = new MediaMetadata({
      title: cur.track.title,
      artist: cur.track.artists.map((a) => a.name).join(', '),
      album: cur.album.title,
      artwork: [{ src: new URL(coverSrc(cur.album, 600), location.href).href, sizes: '600x600' }],
    });
  }, [active, curId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const ms = navigator.mediaSession;
    const state = usePlayer.getState().state;
    const cur = currentItem(state);
    ms.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
    try {
      if (cur && cur.track.durationMs > 0) ms.setPositionState({ duration: cur.track.durationMs / 1000, position: livePosition(state) / 1000, playbackRate: 1 });
    } catch { /* invalid state while loading */ }
  }, [active, status, updatedAt, positionMs, curId]); // eslint-disable-line react-hooks/exhaustive-deps

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
