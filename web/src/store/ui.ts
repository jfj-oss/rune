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

interface UiStore {
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
export const useUi = create<UiStore>((set) => ({
  sidebarCollapsed: load('rune.sidebar', false),
  queueOpen: false,
  nowPlayingOpen: false,
  notice: null,
  toggleSidebar: () => set((s) => { save('rune.sidebar', !s.sidebarCollapsed); return { sidebarCollapsed: !s.sidebarCollapsed }; }),
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  setNowPlayingOpen: (nowPlayingOpen) => set({ nowPlayingOpen }),
  toast: (text) => {
    const id = ++toastN;
    set({ notice: { id, text } });
    setTimeout(() => set((s) => (s.notice?.id === id ? { notice: null } : s)), 3200);
  },
}));

export { load as loadLocal, save as saveLocal };
