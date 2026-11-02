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

/** Space = play / pause anywhere on the page (instead of scrolling or re-clicking the last button). */
export function KeyboardShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
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
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, []);
  return null;
}
