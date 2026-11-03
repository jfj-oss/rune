import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { encId } from '../lib/format';
import { keyCapture } from '../lib/keys';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { shownVolume, useVolumeHold } from '../store/volumeHold';

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

/**
 * Space = play / pause, E / R = volume down / up, 1 / 2 / 3 = previous / restart / next, Z = Home,
 * X = Playlists, the key chosen in Settings (A by default) = the playing song's album, and any playlist hotkeys
 * (set on the playlist's page).
 * Anywhere on the page, not while typing.
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    /** Leave the full-screen player and queue so the page that opens is visible. */
    const go = (path: string) => {
      const ui = useUi.getState();
      ui.setNowPlayingOpen(false);
      ui.setQueueOpen(false);
      navigate(path);
    };

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
      const base = target !== null && now - lastKey < 1500 ? target : shownVolume(usePlayer.getState().state.volume, useVolumeHold.getState());
      lastKey = now;
      // next multiple of the step in that direction (62 → 65 up, 60 down)
      const next = dir > 0 ? Math.floor(base / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP : Math.ceil(base / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP;
      target = Math.max(0, Math.min(100, next));
      useVolumeHold.getState().hold(target); // the slider shows it at once and ignores stale reports
      if (sendTimer) return;
      const wait = Math.max(0, VOLUME_SEND_MS - (now - lastSent));
      sendTimer = window.setTimeout(flush, wait);
    };

    /** 1 = previous song (always the song before, even a few seconds in), 2 = this song from the start, 3 = next. */
    const songKey = (k: '1' | '2' | '3') => {
      const { state, command } = usePlayer.getState();
      if (!state.queue.length) return;
      if (k === '3') { void command({ type: 'next' }); return; }
      if (k === '1' && state.index > 0) { void command({ type: 'jump', index: state.index - 1 }); return; }
      // 2, or 1 on the first song: back to the start of this one, playing
      void command({ type: 'seek', positionMs: 0 }).then(() => {
        if (usePlayer.getState().state.status !== 'playing') void command({ type: 'resume' });
      });
    };

    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (keyCapture.active) return; // a hotkey button is listening for the key
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
      const { albumKey, playlistKeys } = useUi.getState();
      const pl = plain ? playlistKeys[k] : undefined;
      if (pl) {
        e.preventDefault();
        if (!e.repeat) go(`/playlist/${encId(pl.id)}`);
        return;
      }
      if (plain && (k === 'z' || k === 'x' || (albumKey && k === albumKey))) {
        e.preventDefault();
        if (e.repeat) return;
        if (k === 'z') go('/');
        else if (k === 'x') go('/playlists');
        else {
          const { state } = usePlayer.getState();
          const album = state.queue[state.index]?.album;
          if (album?.id && album.id !== 'sp:unknown') go(`/album/${encId(album.id)}`);
        }
        return;
      }
      if ((k === 'e' || k === 'r') && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        stepVolume(k === 'r' ? 1 : -1);
        return;
      }
      if ((k === '1' || k === '2' || k === '3') && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        if (!e.repeat) songKey(k);
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
  }, [navigate]);
  return null;
}
