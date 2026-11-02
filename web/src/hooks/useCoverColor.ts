import { useEffect, useState } from 'react';
import { coverSrc } from '../api';
import { hueOf } from '../lib/color';

const cache = new Map<string, string>();

/** A saturated representative colour (CSS hsl string) from the cover; hash-based fallback. */
export function useCoverColor(album: { id: string; title?: string } | undefined): string {
  const key = album?.id ?? '';
  const [color, setColor] = useState<string>(() => cache.get(key) ?? `hsl(${hueOf(key || 'x')} 40% 30%)`);
  useEffect(() => {
    if (!album) return;
    const hit = cache.get(key);
    if (hit) { setColor(hit); return; }
    setColor(`hsl(${hueOf(key)} 40% 30%)`);
    let dead = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
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
        const out = `rgb(${Math.round(r / w)} ${Math.round(g / w)} ${Math.round(b / w)})`;
        cache.set(key, out);
        if (!dead) setColor(out);
      } catch { /* tainted canvas: keep fallback */ }
    };
    img.src = coverSrc(album, 200);
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return color;
}
