import { create } from 'zustand';
import type { PlayItem } from '../lib/types';

interface TrackMenu {
  x: number;
  y: number;
  item: PlayItem;
}

interface DiscoverUiStore {
  /** Right-click / ⋯ menu for any track row; null when closed. */
  menu: TrackMenu | null;
  /** The song whose radio sheet is open. */
  radio: PlayItem | null;
  openTrackMenu(item: PlayItem, x: number, y: number): void;
  closeTrackMenu(): void;
  openRadio(item: PlayItem): void;
  closeRadio(): void;
}

export const useDiscoverUi = create<DiscoverUiStore>((set) => ({
  menu: null,
  radio: null,
  openTrackMenu: (item, x, y) => set({ menu: { item, x, y } }),
  closeTrackMenu: () => set({ menu: null }),
  openRadio: (item) => set({ radio: item, menu: null }),
  closeRadio: () => set({ radio: null }),
}));
