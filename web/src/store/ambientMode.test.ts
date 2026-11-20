// The backdrop mode setting: Foil waves is the default; every older mode stays selectable and a saved choice wins.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browser(saved?: string, search = '') {
  const store = new Map<string, string>(saved ? [['rune.ambient', saved]] : []);
  const win = new EventTarget() as EventTarget & { matchMedia: () => EventTarget & { matches: boolean } };
  win.matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  const root = { dataset: {} as Record<string, string | undefined> };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { search });
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => [] });
  vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
  return { store, root };
}

describe('backdrop mode', () => {
  it('defaults to Foil waves', async () => {
    const { root } = browser();
    const { useUi, DEFAULT_AMBIENT } = await import('./ui');
    expect(DEFAULT_AMBIENT).toBe('foil');
    expect(useUi.getState().ambient).toBe('foil');
    expect(root.dataset.ambient).toBe('foil');
  });
  it('keeps a saved older mode, and lists Foil waves beside the others', async () => {
    browser('dither-blue');
    const ui = await import('./ui');
    expect(ui.useUi.getState().ambient).toBe('dither-blue');
    expect(ui.FOIL_AMBIENTS).toEqual(['foil']);
    expect(ui.DITHER_AMBIENTS.length).toBeGreaterThan(10);
    expect(ui.AMBIENTS).toContain('off');
    expect(ui.AMBIENT_LABEL.foil).toBe('Foil waves');
  });
  it('can switch between foil and the old modes and remembers it', async () => {
    const { store, root } = browser();
    const { useUi } = await import('./ui');
    useUi.getState().setAmbient('dither');
    expect(store.get('rune.ambient')).toBe('dither');
    useUi.getState().setAmbient('foil');
    expect(store.get('rune.ambient')).toBe('foil');
    expect(root.dataset.ambient).toBe('foil');
  });
  it('accepts ?ambient=foil and ignores junk', async () => {
    browser(undefined, '?ambient=foil');
    expect((await import('./ui')).useUi.getState().ambient).toBe('foil');
    vi.resetModules();
    browser('nonsense');
    expect((await import('./ui')).useUi.getState().ambient).toBe('foil');
  });
});
