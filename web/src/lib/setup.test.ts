import { describe, expect, it } from 'vitest';
import { needsRestart, redirectUris, tailscaleServeCommand, validClientId, type SetupStatus } from './setup';

const base = { redirectUri: 'http://127.0.0.1:4545/api/spotify/callback', publicUrl: '' };

describe('setup helpers', () => {
  it('lists the loopback redirect URI, plus the phone address when set', () => {
    expect(redirectUris(base)).toEqual(['http://127.0.0.1:4545/api/spotify/callback']);
    expect(redirectUris({ ...base, publicUrl: 'https://my-pc.example-tailnet.ts.net:8445/' })).toEqual([
      'http://127.0.0.1:4545/api/spotify/callback',
      'https://my-pc.example-tailnet.ts.net:8445/api/spotify/callback',
    ]);
  });
  it('checks the client id shape', () => {
    expect(validClientId('0123456789abcdef0123456789ABCDEF')).toBe(true);
    expect(validClientId('short')).toBe(false);
    expect(validClientId('')).toBe(false);
  });
  it('builds the tailscale command from the port', () => {
    expect(tailscaleServeCommand(4600)).toBe('tailscale serve --bg --https=8445 http://127.0.0.1:4600');
  });
  it('asks for a restart only when something is waiting', () => {
    const s = { rootsPending: false, spotifyPending: false } as SetupStatus;
    expect(needsRestart(s, false)).toBe(false);
    expect(needsRestart(s, true)).toBe(true);
    expect(needsRestart({ ...s, rootsPending: true }, false)).toBe(true);
  });
});
