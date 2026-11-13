import { describe, expect, it } from 'vitest';
import { ACTIVE_FPS, IDLE_FPS, WAVE_FPS, backdropFrameMs } from './frameRate';

describe('backdrop frame pacing', () => {
  it('runs at 10 fps while music plays or Now Playing is open', () => {
    expect(backdropFrameMs(true, false, false)).toBe(1000 / ACTIVE_FPS);
    expect(backdropFrameMs(false, true, false)).toBe(1000 / ACTIVE_FPS);
  });

  it('stays at 10 fps when idle', () => {
    expect(backdropFrameMs(false, false, false)).toBe(1000 / IDLE_FPS);
    expect(backdropFrameMs(false, false, false)).toBe(100);
    expect(backdropFrameMs(true, false, false)).toBe(100);
  });

  it('draws the new-song swell at 60 fps, whatever else is going on', () => {
    expect(backdropFrameMs(false, false, true)).toBe(1000 / WAVE_FPS);
    expect(backdropFrameMs(true, true, true)).toBe(1000 / WAVE_FPS);
  });
});
