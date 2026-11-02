import { clientLog } from '../clientLog';
import { create } from 'zustand';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ }
}

export type Ambient = 'cycle' | 'blue' | 'purple' | 'slate' | 'green' | 'off' | 'dither' | 'dither-blue' | 'dither-purple' | 'dither-green' | 'dither-cycle';
export const AMBIENTS: Ambient[] = ['cycle', 'blue', 'purple', 'slate', 'green', 'off'];
/** "Dither" backdrop variants (WebGL, see components/DitherBackdrop); plain `dither` is the red default. */
export const DITHER_AMBIENTS: Ambient[] = ['dither', 'dither-blue', 'dither-purple', 'dither-green', 'dither-cycle'];
const isAmbient = (v: unknown): v is Ambient => AMBIENTS.includes(v as Ambient) || DITHER_AMBIENTS.includes(v as Ambient);

/** `rune.ambient` is stored as a plain string; `?ambient=green` in the URL also sets (and persists) it
    (`?ambient=dither-red` is accepted as an alias of `dither`). */
function loadAmbient(): Ambient {
  let v: unknown = null;
  try {
    let q = new URLSearchParams(location.search).get('ambient');
    if (q === 'dither-red') q = 'dither';
    if (isAmbient(q)) { localStorage.setItem('rune.ambient', q); return q; }
    v = localStorage.getItem('rune.ambient');
  } catch { /* storage blocked */ }
  return isAmbient(v) ? v : 'cycle';
}
function applyAmbient(a: Ambient) { document.documentElement.dataset.ambient = a; }

interface UiStore {
  ambient: Ambient;
  setAmbient(a: Ambient): void;
  sidebarCollapsed: boolean;
  queueOpen: boolean;
  nowPlayingOpen: boolean;
  notice: { id: number; text: string } | null;
  toggleSidebar(): void;
  setQueueOpen(v: boolean): void;
  setNowPlayingOpen(v: boolean): void;
  toast(text: string): void;
}

let toastN = 0;
const initialAmbient = loadAmbient();
applyAmbient(initialAmbient);

export const useUi = create<UiStore>((set) => ({
  ambient: initialAmbient,
  setAmbient: (a) => {
    try { localStorage.setItem('rune.ambient', a); } catch { /* storage blocked */ }
    applyAmbient(a);
    set({ ambient: a });
  },
  sidebarCollapsed: load('rune.sidebar', false),
  queueOpen: false,
  nowPlayingOpen: false,
  notice: null,
  toggleSidebar: () => set((s) => { save('rune.sidebar', !s.sidebarCollapsed); return { sidebarCollapsed: !s.sidebarCollapsed }; }),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
  toast: (text) => {
    clientLog('warn', `toast: ${text}`);
    const id = ++toastN;
    set({ notice: { id, text } });
    setTimeout(() => set((s) => (s.notice?.id === id ? { notice: null } : s)), 3200);
  },
}));

export { load as loadLocal, save as saveLocal };
