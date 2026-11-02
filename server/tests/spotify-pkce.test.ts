import { describe, expect, it } from 'vitest';
import { createPkceVerifier, pkceChallenge, SPOTIFY_SCOPES } from '../src/spotify/auth.js';

describe('PKCE (RFC 7636)', () => {
  it('matches the RFC 7636 appendix B test vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates 43-char base64url verifiers', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const v = createPkceVerifier();
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    }
  });

  it('generates unpadded 43-char S256 challenges', () => {
    const challenge = pkceChallenge(createPkceVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toContain('=');
  });

  it('declares exactly the scopes we request from Spotify', () => {
    expect(SPOTIFY_SCOPES).toBe(
      'streaming user-read-email user-read-private user-library-read user-library-modify ' +
        'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private ' +
        'user-read-playback-state ' +
        'user-modify-playback-state user-read-currently-playing user-read-recently-played user-top-read',
    );
  });
});
