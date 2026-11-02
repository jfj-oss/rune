import { useEffect } from 'react';
import { usePlayer } from '../store/player';

/** Typing places keep the space bar for themselves. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

const VOLUME_STEP = 5;
/** Sends at most one volume change per this many ms while a key is held (Spotify rate limits). */
const VOLUME_SEND_MS = 150;

/** Space = play / pause, E = volume down, R = volume up, anywhere on the page (not while typing). */
export function KeyboardShortcuts() {
  useEffect(() => {
    // the volume being aimed at: held keys step from it, not from the (lagging) reported volume
    let target: number | null = null;
    let lastKey = 0;
    let sendTimer = 0;
    let lastSent = 0;
    const flush = () => {
      sendTimer = 0;
      lastSent = performance.now();
      if (target !== null) void usePlayer.getState().command({ type: 'volume', volume: target });
    };
    const stepVolume = (dir: 1 | -1) => {
      const now = performance.now();
      const base = target !== null && now - lastKey < 1500 ? target : usePlayer.getState().state.volume;
      lastKey = now;
      // next multiple of the step in that direction (62 → 65 up, 60 down)
      const next = dir > 0 ? Math.floor(base / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP : Math.ceil(base / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP;
      target = Math.max(0, Math.min(100, next));
      if (sendTimer) return;
      const wait = Math.max(0, VOLUME_SEND_MS - (now - lastSent));
      sendTimer = window.setTimeout(flush, wait);
    };

    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((k === 'e' || k === 'r') && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        stepVolume(k === 'r' ? 1 : -1);
        return;
      }
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const { state, command } = usePlayer.getState();
      if (!state.queue.length) return;
      const playing = state.status === 'playing' || state.status === 'loading';
      void command({ type: playing ? 'pause' : 'resume' });
    };
    // a focused button would otherwise "click" on key-up
    const up = (e: KeyboardEvent) => {
      if ((e.code === 'Space' || e.key === ' ') && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) e.preventDefault();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      clearTimeout(sendTimer);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, []);
  return null;
}
