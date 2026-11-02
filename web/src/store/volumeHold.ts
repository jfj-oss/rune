import { create } from 'zustand';

/** How long a chosen volume is shown after the last change, whatever the zone reports meanwhile. */
export const VOLUME_HOLD_MS = 3000;

/**
 * The volume the user just chose (slider or E/R keys), shared by every volume control.
 * Spotify devices keep reporting older levels for a second or two after a change, and a
 * run of quick changes comes back one by one; showing those made the slider jump around.
 */
interface VolumeHold {
  v: number | null;
  until: number;
  hold(v: number): void;
  clear(): void;
}

export const useVolumeHold = create<VolumeHold>((set) => ({
  v: null,
  until: 0,
  hold: (v) => set({ v, until: Date.now() + VOLUME_HOLD_MS }),
  clear: () => set({ v: null, until: 0 }),
}));

/** The volume to show: the held choice while it lasts, else what the zone reports. */
export function shownVolume(reported: number, h: { v: number | null; until: number }, now = Date.now()): number {
  return h.v !== null && now < h.until ? h.v : reported;
}
