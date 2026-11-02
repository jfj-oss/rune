/** A friendly name for this device ("This Mac", "This iPhone" ...). */
export function deviceName(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent, touchPoints = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints): string {
  if (/iPhone/.test(ua)) return 'This iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'This iPad';
  if (/Macintosh/.test(ua)) return 'This Mac';
  if (/Android/.test(ua)) return 'This phone';
  return 'This computer';
}

/**
 * The Spotify Web Playback SDK does not run on phones/tablets (and needs EME + a secure context).
 * Pure so it can be unit-tested; `sdkSupported()` feeds it the real browser.
 */
export function sdkSupportedFor(env: { ua: string; touchPoints: number; secure: boolean; hasEme: boolean }): boolean {
  if (!env.secure || !env.hasEme) return false;
  if (/iPhone|iPod|iPad|Android|Mobile/i.test(env.ua)) return false;
  if (/Macintosh/.test(env.ua) && env.touchPoints > 1) return false; // iPadOS pretending to be a Mac
  return true;
}

export function sdkSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return sdkSupportedFor({
    ua: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints,
    secure: window.isSecureContext,
    hasEme: typeof navigator.requestMediaKeySystemAccess === 'function',
  });
}
