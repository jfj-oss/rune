import { hashString } from '../lib/color';
import { initials } from '../lib/format';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, string>();
const titles = new Map<string, string>();
/** Lets covers keep the album's real initials even when callers only know the id. */
export function registerTitles(list: { id: string; title: string }[]) {
  for (const a of list) titles.set(a.id, a.title);
}

/** Deterministic generated placeholder cover (no external art): gradient + shapes + initials. */
export function mockCover(id: string, titleIn: string): string {
  const title = titles.get(id) ?? titleIn;
  const key = id + '|' + title;
  const hit = cache.get(key);
  if (hit) return hit;
  const seed = hashString(id);
  const r = rng(seed);
  const h1 = Math.floor(r() * 360);
  const h2 = (h1 + 40 + Math.floor(r() * 140)) % 360;
  const l1 = 38 + Math.floor(r() * 16);
  const l2 = 18 + Math.floor(r() * 14);
  const style = seed % 5;
  let shapes = '';
  const c = (n: number) => Math.round(n * 10) / 10;
  if (style === 0) {
    for (let i = 0; i < 6; i++) {
      shapes += `<circle cx="${c(r() * 600)}" cy="${c(r() * 600)}" r="${c(60 + r() * 190)}" fill="hsl(${(h1 + i * 24) % 360} 70% ${55 + i * 3}%)" fill-opacity="${c(0.16 + r() * 0.18)}"/>`;
    }
  } else if (style === 1) {
    for (let i = 0; i < 9; i++) {
      shapes += `<rect x="${c(-40 + i * 76)}" y="-40" width="${c(30 + r() * 40)}" height="700" fill="hsl(${h2} 80% 70%)" fill-opacity="${c(0.07 + r() * 0.12)}" transform="rotate(${c(14 + r() * 8)} 300 300)"/>`;
    }
  } else if (style === 2) {
    for (let i = 1; i <= 7; i++) {
      shapes += `<circle cx="300" cy="${c(340 + r() * 20)}" r="${i * 46}" fill="none" stroke="hsl(${h2} 80% 78%)" stroke-opacity="${c(0.1 + r() * 0.2)}" stroke-width="${c(3 + r() * 9)}"/>`;
    }
  } else if (style === 3) {
    shapes += `<circle cx="${c(180 + r() * 240)}" cy="${c(140 + r() * 160)}" r="${c(90 + r() * 70)}" fill="hsl(${(h1 + 180) % 360} 85% 70%)" fill-opacity=".8"/>`;
    shapes += `<path d="M0 ${c(400 + r() * 100)} Q 300 ${c(250 + r() * 120)} 600 ${c(400 + r() * 100)} V600 H0Z" fill="hsl(${h2} 50% 12%)" fill-opacity=".72"/>`;
  } else {
    for (let i = 0; i < 5; i++) {
      const x = c(r() * 400);
      const y = c(r() * 400);
      const s = c(120 + r() * 180);
      shapes += `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="hsl(${(h1 + i * 30) % 360} 65% ${50 + i * 4}%)" fill-opacity="${c(0.14 + r() * 0.2)}" transform="rotate(${c(r() * 60 - 30)} ${c(x + s / 2)} ${c(y + s / 2)})"/>`;
    }
  }
  const ini = initials(title);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 58% ${l1}%)"/><stop offset="1" stop-color="hsl(${h2} 62% ${l2}%)"/></linearGradient></defs>` +
    `<rect width="600" height="600" fill="url(#g)"/>${shapes}` +
    `<text x="40" y="560" font-family="Inter,Arial,sans-serif" font-weight="700" font-size="120" fill="#fff" fill-opacity=".86" letter-spacing="-3">${ini}</text>` +
    `</svg>`;
  const uri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  cache.set(key, uri);
  return uri;
}
