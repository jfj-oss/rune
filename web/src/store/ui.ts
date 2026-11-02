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
export const AMBIENT_LABEL: Record<Ambient, string> = {
  cycle: 'Cycle', blue: 'Blue', purple: 'Purple', slate: 'Slate', green: 'Green', off: 'Off',
  dither: 'Dither · Red', 'dither-blue': 'Dither · Blue', 'dither-purple': 'Dither · Purple', 'dither-green': 'Dither · Green', 'dither-cycle': 'Dither · Cycle',
};
const isAmbient = (v: unknown): v is Ambient => AMBIENTS.includes(v as Ambient) || DITHER_AMBIENTS.includes(v as Ambient);

/** `rune.ambient` is stored as a plain string; `?ambient=green` in the URL also sets (and persists) it
    (`?ambient=dither-red` is accepted as an alias of `dither`). */
/** True when the URL picked the ambient (`?ambient=`): that wins over the shared server choice for this load. */
let ambientFromUrl = false;
function loadAmbient(): Ambient {
  let v: unknown = null;
  try {
    let q = new URLSearchParams(location.search).get('ambient');
    if (q === 'dither-red') q = 'dither';
    if (isAmbient(q)) { ambientFromUrl = true; localStorage.setItem('rune.ambient', q); return q; }
    v = localStorage.getItem('rune.ambient');
  } catch { /* storage blocked */ }
  return isAmbient(v) ? v : 'dither';
}
/** Page colour behind everything; iOS home-screen apps also paint their status/home-bar strips with it. */
const PAGE_BG: Partial<Record<Ambient, string>> = { off: '#0f1013' };
function applyAmbient(a: Ambient) {
  if (typeof document === 'undefined') return; // node (unit tests): nothing to paint
  document.documentElement.dataset.ambient = a;
  const bg = a.startsWith('dither') ? '#000000' : PAGE_BG[a] ?? '#00161c';
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.setAttribute('content', bg);
}

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
    void syncAmbient('push', a);
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

/** Share the ambient across devices through the server (skipped in mock mode). */
async function syncAmbient(dir: 'pull' | 'push', a?: Ambient): Promise<void> {
  try {
    const { isMock } = await import('../api');
    if (isMock) return;
    if (dir === 'push') {
      await fetch('/api/settings/ambient', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ambient: a }) });
      return;
    }
    const res = await fetch('/api/settings/ambient');
    if (!res.ok) return;
    const { ambient } = (await res.json()) as { ambient: unknown };
    if (!isAmbient(ambient)) {
      // nothing shared yet: offer this device's choice, but only one it actually picked (not the default)
      let picked: string | null = null;
      try { picked = localStorage.getItem('rune.ambient'); } catch { /* storage blocked */ }
      if (isAmbient(picked)) void syncAmbient('push', picked);
      return;
    }
    if (ambient === useUi.getState().ambient) return;
    try { localStorage.setItem('rune.ambient', ambient); } catch { /* storage blocked */ }
    applyAmbient(ambient);
    useUi.setState({ ambient });
  } catch { /* offline: keep the local choice */ }
}
if (typeof window !== 'undefined' && !ambientFromUrl) void syncAmbient('pull');
