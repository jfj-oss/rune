export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hueOf(key: string): number {
  return hashString(key) % 360;
}

/** Two-stop gradient for placeholder tiles / avatars, derived from a key. */
export function tileGradient(key: string): string {
  const h = hueOf(key);
  return `linear-gradient(135deg, hsl(${h} 46% 34%), hsl(${(h + 48) % 360} 52% 22%))`;
}
