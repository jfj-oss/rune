/** m:ss, or h:mm:ss from an hour up. Never throws on bad input. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** "41 min", "1 hr 12 min" — rounded to the nearest minute. */
export function formatTotalLength(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(the|a|an|and|&|of)$/i.test(w));
  const pick = words.length ? words : name.split(/\s+/).filter(Boolean);
  const out = pick.slice(0, 2).map((w) => w[0] ?? '').join('');
  return (out || '?').toUpperCase();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function encId(id: string): string {
  return encodeURIComponent(id);
}
