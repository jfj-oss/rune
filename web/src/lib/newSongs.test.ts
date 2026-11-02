import { describe, expect, it } from 'vitest';
import { contextMenuPosition } from './newSongs';

describe('contextMenuPosition', () => {
  it('opens down-right from the cursor when it fits', () => {
    expect(contextMenuPosition(120, 90, 240, 320, 1600, 1000)).toEqual({ left: 120, top: 90 });
  });

  it('flips left when the menu would cross the right edge', () => {
    expect(contextMenuPosition(1500, 90, 240, 320, 1600, 1000)).toEqual({ left: 1352, top: 90 });
  });

  it('flips up when the menu would cross the bottom edge', () => {
    expect(contextMenuPosition(120, 950, 240, 320, 1600, 1000)).toEqual({ left: 120, top: 672 });
  });

  it('keeps the menu at the padding when it is larger than the viewport', () => {
    expect(contextMenuPosition(370, 800, 400, 900, 390, 844)).toEqual({ left: 8, top: 8 });
  });

  it('leaves an exactly-fitting menu at the cursor', () => {
    expect(contextMenuPosition(1000, 500, 592, 492, 1600, 1000)).toEqual({ left: 1000, top: 500 });
  });
});
