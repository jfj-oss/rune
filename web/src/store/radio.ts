import { create } from 'zustand';
import { listenApi } from '../listenApi';
import type { RadioPick } from '../lib/listenTypes';
import { loadLocal, saveLocal } from './ui';
import { useUi } from './ui';

interface RadioStore {
  /** trackId -> why rune radio picked it. */
  reasons: Record<string, string>;
  /** The track ids a rune-radio session grew from (fed to /radio/next). */
  seeds: string[];
  active: boolean;
  autoRadio: boolean;
  autoRadioLoaded: boolean;
  notePicks(picks: RadioPick[]): void;
  startSession(seeds: string[], picks: RadioPick[]): void;
  setAutoRadio(enabled: boolean): Promise<void>;
  loadAutoRadio(): Promise<void>;
}

const initialAuto = loadLocal<boolean>('rune.autoRadio', false);

export const useRadio = create<RadioStore>((set, get) => ({
  reasons: {},
  seeds: [],
  active: false,
  autoRadio: initialAuto,
  autoRadioLoaded: false,

  notePicks: (picks) => set((s) => {
    if (!picks.length) return s;
    const reasons = { ...s.reasons };
    for (const p of picks) reasons[p.trackId] = p.reason;
    return { reasons };
  }),

  startSession: (seeds, picks) => set((s) => {
    const reasons = { ...s.reasons };
    for (const p of picks) reasons[p.trackId] = p.reason;
    return { reasons, seeds, active: true };
  }),

  setAutoRadio: async (enabled) => {
    const prev = get().autoRadio;
    set({ autoRadio: enabled });
    saveLocal('rune.autoRadio', enabled);
    try {
      const saved = await listenApi.setAutoRadio(enabled);
      set({ autoRadio: saved, autoRadioLoaded: true });
    } catch {
      set({ autoRadio: prev });
      saveLocal('rune.autoRadio', prev);
      useUi.getState().toast('Could not save the auto-radio setting');
    }
  },

  loadAutoRadio: async () => {
    if (get().autoRadioLoaded) return;
    try {
      const enabled = await listenApi.autoRadio();
      saveLocal('rune.autoRadio', enabled);
      set({ autoRadio: enabled, autoRadioLoaded: true });
    } catch {
      set({ autoRadioLoaded: true });
    }
  },
}));
