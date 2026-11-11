import { describe, expect, it } from 'vitest';
import { detectIOS, formatVolume, posToVolume, remoteVolumeHint, snapVolume, stepVolume, volumeToPos } from './volume';

describe('volume mapping', () => {
  it('has the right endpoints and midpoint', () => {
    expect(posToVolume(0)).toBe(0);
    expect(posToVolume(1)).toBe(100);
    expect(posToVolume(0.5)).toBe(25);
    expect(volumeToPos(25)).toBe(0.5);
    expect(volumeToPos(0)).toBe(0);
    expect(volumeToPos(100)).toBe(1);
  });
  it('left half covers 0..25, right half 25..100', () => {
    expect(posToVolume(0.25)).toBe(12.5);
    expect(posToVolume(0.75)).toBe(62.5);
    expect(posToVolume(0.4999)).toBeLessThanOrEqual(25);
    expect(posToVolume(0.5001)).toBeGreaterThan(25);
  });
  it('clamps out-of-range input', () => {
    expect(posToVolume(-1)).toBe(0);
    expect(posToVolume(2)).toBe(100);
    expect(volumeToPos(-5)).toBe(0);
    expect(volumeToPos(500)).toBe(1);
  });
  it('round-trips', () => {
    for (let i = 0; i <= 1000; i++) {
      const p = i / 1000;
      expect(volumeToPos(posToVolume(p))).toBeCloseTo(p, 10);
    }
    for (let v = 0; v <= 100; v += 0.5) expect(posToVolume(volumeToPos(v))).toBeCloseTo(v, 10);
  });
  it('is monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const v = posToVolume(i / 1000);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('snapVolume / stepVolume', () => {
  it('snaps to 0.5 below 25 and to whole numbers above', () => {
    expect(snapVolume(12.3)).toBe(12.5);
    expect(snapVolume(12.1)).toBe(12);
    expect(snapVolume(24.8)).toBe(25);
    expect(snapVolume(40.4)).toBe(40);
    expect(snapVolume(-3)).toBe(0);
    expect(snapVolume(120)).toBe(100);
  });
  it('steps 0.5 below 25 and 2 above', () => {
    expect(stepVolume(10, 1)).toBe(10.5);
    expect(stepVolume(10, -1)).toBe(9.5);
    expect(stepVolume(24.5, 1)).toBe(25);
    expect(stepVolume(25, 1)).toBe(27);
    expect(stepVolume(25, -1)).toBe(24.5);
    expect(stepVolume(50, 1)).toBe(52);
    expect(stepVolume(50, -1)).toBe(48);
  });
  it('shift is coarser and everything is clamped', () => {
    expect(stepVolume(10, 1, true)).toBe(12.5);
    expect(stepVolume(50, 1, true)).toBe(60);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(100, 1)).toBe(100);
  });
});

describe('formatVolume', () => {
  it('shows halves only when needed', () => {
    expect(formatVolume(12.5)).toBe('12.5%');
    expect(formatVolume(40)).toBe('40%');
    expect(formatVolume(0)).toBe('0%');
  });
  it('never throws on a missing or non-finite level from stale server state', () => {
    expect(formatVolume(null)).toBe('—');
    expect(formatVolume(undefined)).toBe('—');
    expect(formatVolume(Number.NaN)).toBe('—');
    expect(formatVolume(Number.POSITIVE_INFINITY)).toBe('—');
  });
  it('treats a non-finite level as 0 for slider maths', () => {
    expect(posToVolume(Number.NaN)).toBe(0);
    expect(volumeToPos(Number.NaN)).toBe(0);
    expect(snapVolume(Number.NaN)).toBe(0);
    expect(volumeToPos(null as unknown as number)).toBe(0);
  });
});

describe('detectIOS', () => {
  it('detects iPhone, iPad and iPadOS desktop UA', () => {
    expect(detectIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(detectIOS('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(detectIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('iPad');
    expect(detectIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBeNull();
    expect(detectIOS('Mozilla/5.0 (X11; Linux x86_64) Chrome/130')).toBeNull();
  });
});

describe('remoteVolumeHint', () => {
  it('tells the user to use the device’s own buttons when Spotify cannot set its volume', () => {
    expect(remoteVolumeHint({ name: 'iPhone — Spotify', deviceType: 'Smartphone' })).toBe('Use the volume buttons on iPhone');
    expect(remoteVolumeHint({ name: 'Justin’s iPad' })).toBe('Use the volume buttons on Justin’s iPad');
    expect(remoteVolumeHint({ name: 'Kitchen', deviceType: 'Speaker' })).toBe('Set the volume on Kitchen itself');
  });
});
