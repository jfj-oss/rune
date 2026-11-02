import { describe, expect, it } from 'vitest';
import { isLiveTrack } from './listenTypes';

describe('isLiveTrack', () => {
  it('recognises internet-radio ids', () => {
    expect(isLiveTrack({ id: 'rs:0b6c2a1e-0000' })).toBe(true);
    expect(isLiveTrack({ id: 'rs:mock-001-abc' })).toBe(true);
  });
  it('is false for local, Spotify, empty and missing ids', () => {
    expect(isLiveTrack({ id: 'la:track-1' })).toBe(false);
    expect(isLiveTrack({ id: 'sp:4uLU6hMCjMI75M1A2tKUQC' })).toBe(false);
    expect(isLiveTrack({ id: '' })).toBe(false);
    expect(isLiveTrack({})).toBe(false);
    expect(isLiveTrack(null)).toBe(false);
    expect(isLiveTrack(undefined)).toBe(false);
  });
  it('only trusts the start of the id', () => {
    expect(isLiveTrack({ id: 'la:rs:not-radio' })).toBe(false);
  });
});
