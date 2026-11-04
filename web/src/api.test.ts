import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, http } from './api';

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

describe('spotify + scan API shapes', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (payload: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })));
  };

  it('spotifyStatus keeps working when the server says Spotify is not configured', async () => {
    respond({ connected: false, configured: false });
    await expect(api.spotifyStatus()).resolves.toEqual({ connected: false, configured: false });
  });

  it('fetching scan errors returns their paths and reasons', async () => {
    respond([{ path: 'Artist/Album/broken.flac', reason: 'End-Of-Stream' }]);
    await expect(api.scanErrors()).resolves.toEqual([{ path: 'Artist/Album/broken.flac', reason: 'End-Of-Stream' }]);
  });
});
