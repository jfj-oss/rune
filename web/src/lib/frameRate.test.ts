import { describe, expect, it } from 'vitest';
import { ACTIVE_FPS, IDLE_FPS, backdropFrameMs } from './frameRate';

describe('backdrop frame pacing', () => {
  it('runs at 30 fps while music plays or Now Playing is open', () => {
    expect(backdropFrameMs(true, false, false)).toBe(1000 / ACTIVE_FPS);
    expect(backdropFrameMs(false, true, false)).toBe(1000 / ACTIVE_FPS);
  });

  it('drops to ~12 fps when idle', () => {
    expect(backdropFrameMs(false, false, false)).toBe(1000 / IDLE_FPS);
    expect(backdropFrameMs(false, false, false)).toBeCloseTo(83.33, 1);
  });

  it('keeps 30 fps for the new-song pulse even when paused with the sheet closed', () => {
    expect(backdropFrameMs(false, false, true)).toBe(1000 / ACTIVE_FPS);
  });
});
