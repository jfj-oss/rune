/* Frame pacing for the ambient dither backdrop (and other decorative animation). */

export const ACTIVE_FPS = 30;
export const IDLE_FPS = 12;
/** The new-song swell grows fast: draw it smoothly. */
export const WAVE_FPS = 60;

/** The backdrop animates at 30 fps while music plays, Now Playing is open, or the new-song pulse runs;
    the new-song swell at 60 fps; otherwise the forms drift at ~12 fps. Returns the minimum gap between drawn frames in ms. */
export function backdropFrameMs(playing: boolean, nowPlayingOpen: boolean, pulsing: boolean): number {
  if (pulsing) return 1000 / WAVE_FPS;
  return 1000 / (playing || nowPlayingOpen ? ACTIVE_FPS : IDLE_FPS);
}
