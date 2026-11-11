import { describe, expect, it } from 'vitest';
import { devicePlace, isHandheld } from './device';

describe('isHandheld (a personal device: never follows the PC speakers on its own)', () => {
  it('is true for phones and tablets, iPadOS-as-Mac included, and false for desktops', () => {
    expect(isHandheld('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605 Mobile/15E148 Safari/604', 5)).toBe(true);
    expect(isHandheld('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5)).toBe(true);
    expect(isHandheld('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0 Mobile Safari/537.36', 5)).toBe(true);
    expect(isHandheld('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0', 0)).toBe(false);
    expect(isHandheld('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0', 0)).toBe(false);
  });
});

describe('devicePlace (the name other devices see)', () => {
  it('names the machine, never "this computer"', () => {
    expect(devicePlace('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0')).toBe('Linux PC');
    expect(devicePlace('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/156.0', 0)).toBe('Mac');
    expect(devicePlace('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5)).toBe('iPad');
    expect(devicePlace('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)')).toBe('iPhone');
    expect(devicePlace('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0')).toBe('Windows PC');
  });
});
