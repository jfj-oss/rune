import { useEffect, useState } from 'react';
import { coverSrc } from '../api';
import { dominantColour, hueOf } from '../lib/color';

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
        const out = dominantColour(img);
        if (!out) return;
        cache.set(key, out);
        if (!dead) setColor(out);
      } catch { /* tainted canvas: keep fallback */ }
    };
    img.src = coverSrc(album, 200);
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return color;
}
