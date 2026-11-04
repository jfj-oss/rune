import { afterEach, describe, expect, it, vi } from 'vitest';
import { http } from './api';

describe('http', () => {
  afterEach(() => vi.unstubAllGlobals());
  const capture = () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { calls.push(init); return new Response('{}', { status: 200 }); }));
    return calls;
  };
  const type = (init: RequestInit) => (init.headers as Record<string, string>)['content-type'];

  it('does not label a bodiless POST as JSON (the server would reject it: Spotify never started on the PC)', async () => {
    const calls = capture();
    await http('/pc/spotify/start', { method: 'POST' });
    expect(type(calls[0]!)).toBeUndefined();
  });
  it('labels a JSON body as JSON', async () => {
    const calls = capture();
    await http('/settings/hotkeys', { method: 'POST', body: JSON.stringify({ albumKey: '' }) });
    expect(type(calls[0]!)).toBe('application/json');
  });
});
