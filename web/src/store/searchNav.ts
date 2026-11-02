import { create } from 'zustand';

export interface NavItem { key: string; activate(): void }
interface S { items: NavItem[]; active: number; set(items: NavItem[]): void; move(d: 1 | -1): void; reset(): void }

export const useSearchNav = create<S>((set) => ({
  items: [],
  active: -1,
  set: (items) => set({ items, active: -1 }),
  move: (d) => set((s) => (s.items.length ? { active: s.active < 0 ? (d === 1 ? 0 : s.items.length - 1) : (s.active + d + s.items.length) % s.items.length } : s)),
  reset: () => set({ items: [], active: -1 }),
}));
