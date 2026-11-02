import { create } from 'zustand';
import type { PlayItem } from '../lib/types';
import type { PlaylistOrder } from '../lib/playlists';
import { loadLocal, saveLocal } from './ui';

/** What the "Add to playlist" picker should add. `resolve` runs on pick (an album's tracks are fetched lazily). */
export interface PickerRequest {
  title: string;
  /** one line under the title: "Glass Harbour · 10 tracks" */
  what: string;
  resolve(): Promise<PlayItem[]> | PlayItem[];
  /** suggested name when the user creates a new playlist from the picker */
  newName?: string;
}
export interface NewPlaylistRequest {
  name?: string;
  /** tracks to put in the new playlist (optional) */
  resolve?: () => Promise<PlayItem[]> | PlayItem[];
  what?: string;
}

interface PlaylistUi {
  picker: PickerRequest | null;
  newPlaylist: NewPlaylistRequest | null;
  smart: boolean;
  /** Newest-added first, or the playlist's own order (remembered on this device). */
  order: PlaylistOrder;
  setOrder(o: PlaylistOrder): void;
  openPicker(r: PickerRequest): void;
  closePicker(): void;
  openNew(r?: NewPlaylistRequest): void;
  closeNew(): void;
  openSmart(): void;
  closeSmart(): void;
}

export const usePlaylistUi = create<PlaylistUi>((set) => ({
  picker: null,
  newPlaylist: null,
  smart: false,
  order: loadLocal<PlaylistOrder>('rune.playlistOrder', 'added') === 'playlist' ? 'playlist' : 'added',
  setOrder: (order) => { saveLocal('rune.playlistOrder', order); set({ order }); },
  openPicker: (picker) => set({ picker }),
  closePicker: () => set({ picker: null }),
  openNew: (r) => set({ newPlaylist: r ?? {} }),
  closeNew: () => set({ newPlaylist: null }),
  openSmart: () => set({ smart: true }),
  closeSmart: () => set({ smart: false }),
}));
