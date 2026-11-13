/* Frame pacing for the ambient dither backdrop (and other decorative animation). */

export const ACTIVE_FPS = 10;
export const IDLE_FPS = 10;
/** The new-song swell grows fast: draw it smoothly. */
export const WAVE_FPS = 60;

/** The backdrop drifts at 10 fps whether music plays or not (it was 30 while playing: a quarter of the GPU on the PC for a
    slow drift); only the short new-song swell runs at 60 fps. Returns the minimum gap between drawn frames in ms. */
export function backdropFrameMs(playing: boolean, nowPlayingOpen: boolean, pulsing: boolean): number {
  if (pulsing) return 1000 / WAVE_FPS;
  return 1000 / (playing || nowPlayingOpen ? ACTIVE_FPS : IDLE_FPS);
}
