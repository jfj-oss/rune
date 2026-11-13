// "Reduce effects": the setting persists per device, puts data-effects="reduced" on <html>, and the animated parts go
// still through stillQuery(), exactly as with the system's reduced motion. A plain node environment: a minimal fake
// document/window/localStorage stands in for the browser.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function browser(opts: { saved?: string; systemReduced?: boolean } = {}) {
  const store = new Map<string, string>(opts.saved ? [['rune.reduceEffects', opts.saved]] : []);
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = opts.systemReduced ?? false;
  const win = new EventTarget() as EventTarget & { matchMedia: (q: string) => typeof media };
  win.matchMedia = (q: string) => (q.includes('prefers-reduced-motion') ? media : Object.assign(new EventTarget(), { matches: false }));
  const root = { dataset: {} as Record<string, string | undefined> };
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { search: '' });
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => [] });
  return { store, root, media };
}

describe('Reduce effects', () => {
  it('is off by default: no attribute, nothing stands still', async () => {
    const { root } = browser();
    const { useUi } = await import('../store/ui');
    const { stillQuery } = await import('./effects');
    expect(useUi.getState().reduceEffects).toBe(false);
    expect(root.dataset.effects).toBeUndefined();
    expect(stillQuery().matches).toBe(false);
  });

  it('switched on: persisted on this device, on <html> at once, and the next load starts with it', async () => {
    const b = browser();
    const { useUi } = await import('../store/ui');
    useUi.getState().setReduceEffects(true);
    expect(useUi.getState().reduceEffects).toBe(true);
    expect(b.root.dataset.effects).toBe('reduced');
    expect(b.store.get('rune.reduceEffects')).toBe('1');

    // a reload of the page
    vi.resetModules();
    b.root.dataset = {};
    const again = await import('../store/ui');
    expect(again.useUi.getState().reduceEffects).toBe(true);
    expect(b.root.dataset.effects).toBe('reduced');

    again.useUi.getState().setReduceEffects(false);
    expect(b.root.dataset.effects).toBeUndefined();
    expect(b.store.has('rune.reduceEffects')).toBe(false);
  });

  it('the animated parts go still when it is switched on, and move again when it is off (they are told at once)', async () => {
    browser();
    const { useUi } = await import('../store/ui');
    const { stillQuery } = await import('./effects');
    const q = stillQuery();
    const changes = vi.fn();
    q.addEventListener('change', changes);
    useUi.getState().setReduceEffects(true);
    expect(q.matches).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    useUi.getState().setReduceEffects(false);
    expect(q.matches).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    q.removeEventListener('change', changes);
    useUi.getState().setReduceEffects(true);
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('the system\'s reduced motion still stands things still with the setting off', async () => {
    const { media } = browser({ systemReduced: true });
    const { stillQuery } = await import('./effects');
    const q = stillQuery();
    const changes = vi.fn();
    q.addEventListener('change', changes);
    expect(q.matches).toBe(true);
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(changes).toHaveBeenCalledTimes(1);
    expect(q.matches).toBe(false);
  });

  it('every animated part asks stillQuery(), not the media query alone', () => {
    const dir = join(__dirname, '../components');
    for (const f of ['AsciiWaves.tsx', 'WaveCover.tsx', 'Logo.tsx', 'DitherBackdrop.tsx', 'Shell.tsx']) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).toContain('stillQuery()');
      expect(src, f).not.toMatch(/matchMedia\('\(prefers-reduced-motion/);
    }
  });

  it('no blur survives the setting: the override covers every element and pseudo-element', () => {
    const css = readFileSync(join(__dirname, '../styles/effects.css'), 'utf8');
    expect(css).toMatch(/:root\[data-effects='reduced'\] \*,\s*:root\[data-effects='reduced'\] \*::before,\s*:root\[data-effects='reduced'\] \*::after \{\s*-webkit-backdrop-filter: none !important;\s*backdrop-filter: none !important;/);
    const main = readFileSync(join(__dirname, '../main.tsx'), 'utf8');
    expect(main).toContain("import './styles/effects.css';");
  });
});
