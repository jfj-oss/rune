import type { PlayerState } from '@liner/shared';
import { browseApi } from '../browseApi';
import { isMock } from '../api';
import { usePlayer } from '../store/player';
import { PlayTracker } from './playTracker';

/**
 * Reports browser-zone listens to POST /api/history/played (the server never sees that zone's
 * PlayerState). Subscribes from outside the player store so the store itself stays untouched.
 * Returns an unsubscribe function.
 */
export function startHistoryReporter(): () => void {
  if (isMock) return () => undefined;
  const tracker = new PlayTracker((r) => { void browseApi.historyPlayed(r, { keepalive: true }); });
  const isBrowserZone = (state: PlayerState, zones: { id: string; kind: string }[]) =>
    zones.find((z) => z.id === state.zone)?.kind === 'browser';

  const push = () => {
    const { state, zones } = usePlayer.getState();
    tracker.update(isBrowserZone(state, zones) ? state : null);
  };
  push();
  const unsub = usePlayer.subscribe(push);
  const leaving = () => tracker.flush();
  window.addEventListener('pagehide', leaving);
  return () => { unsub(); window.removeEventListener('pagehide', leaving); tracker.flush(); };
}
