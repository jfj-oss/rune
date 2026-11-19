/**
 * The id this browser keeps (in its own storage) so the server can hold its queue: the browser zone is "browser:<id>".
 * Letters and digits only, 22 long; the server accepts 6–64 of [A-Za-z0-9_-].
 */
const KEY = 'rune.client';

function fresh(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36) + (Math.floor(b / 36) % 36).toString(36);
  return out.slice(0, 22);
}

let memory: string | null = null;

export function clientId(): string {
  if (memory) return memory;
  let id: string | null = null;
  try { id = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    id = fresh();
    try { localStorage.setItem(KEY, id); } catch { /* storage blocked: this page's own id until it closes */ }
  }
  memory = id;
  return id;
}

export const browserZoneId = (): string => `browser:${clientId()}`;
