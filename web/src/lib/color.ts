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

/** A saturated representative colour (`rgb(r g b)`) of a loaded image: a 24x24 sample weighted toward vivid, bright
    pixels. Throws if the canvas is tainted (cross-origin image without CORS). */
export function dominantColour(img: CanvasImageSource): string | null {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, 24, 24);
  const d = ctx.getImageData(0, 0, 24, 24).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i] as number, G = d[i + 1] as number, B = d[i + 2] as number;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const sat = max === 0 ? 0 : (max - min) / max;
    const wt = 0.05 + sat * sat * (max / 255);
    r += R * wt; g += G * wt; b += B * wt; w += wt;
  }
  return `rgb(${Math.round(r / w)} ${Math.round(g / w)} ${Math.round(b / w)})`;
}
