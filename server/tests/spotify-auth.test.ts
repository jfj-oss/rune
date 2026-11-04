import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import {
  SpotifyAuth,
  SpotifyAuthError,
  pkceChallenge,
  SPOTIFY_SCOPES,
  ensureSpotifySchema,
} from '../src/spotify/auth.js';
import type { FetchLike } from '../src/spotify/fetch.js';
import {
  TEST_CONFIG,
  fakeFetch,
  formBody,
  jsonResponse,
} from './spotify-helpers.js';

const ENDPOINTS = { accounts: 'http://auth.test', api: 'http://api.test/v1' };

function makeAuth(fetchImpl: FetchLike, now?: () => number) {
  const db = openDb(':memory:');
  ensureSpotifySchema(db);
  const auth = new SpotifyAuth(db, TEST_CONFIG, { fetch: fetchImpl, endpoints: ENDPOINTS, now });
  return { db, auth };
}

describe('SpotifyAuth', () => {
  it('builds the authorize URL with PKCE S256 and all scopes', () => {
    const db = openDb(':memory:');
    const auth = new SpotifyAuth(db, TEST_CONFIG);
    const url = new URL(auth.loginUrl());

    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4545/api/spotify/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('scope')).toBe(SPOTIFY_SCOPES);
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('errors clearly when no client id is configured', () => {
    const db = openDb(':memory:');
    const auth = new SpotifyAuth(db, { ...TEST_CONFIG, spotifyClientId: undefined });
    expect(() => auth.loginUrl()).toThrow(/not configured.*spotifyClientId/i);
  });

  it('exchanges the callback code with the stored verifier and caches the profile', async () => {
    const tokenRequests: URLSearchParams[] = [];
    let authorizeChallenge = '';
    const { fetch } = fakeFetch(async (url, init) => {
      if (url.pathname === '/api/token') {
        const form = formBody(init);
        tokenRequests.push(form);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('code-123');
        expect(form.get('client_id')).toBe('client-abc');
        expect(form.get('redirect_uri')).toBe('http://127.0.0.1:4545/api/spotify/callback');
        // Proves the verifier sent here is the pre-image of the challenge that
        // went out in the authorize URL (real PKCE round-trip, offline).
        expect(pkceChallenge(form.get('code_verifier') ?? '')).toBe(authorizeChallenge);
        return jsonResponse(200, {
          access_token: 'access-1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
          scope: SPOTIFY_SCOPES,
        });
      }
      if (url.pathname === '/v1/me') {
        expect(init?.headers?.Authorization).toBe('Bearer access-1');
        return jsonResponse(200, { id: 'user-1', display_name: 'Listener', product: 'premium' });
      }
      return jsonResponse(404, { error: 'unexpected' });
    });

    const { db, auth } = makeAuth(fetch);
    const authorizeUrl = new URL(auth.loginUrl());
    authorizeChallenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
    const state = authorizeUrl.searchParams.get('state') ?? '';

    const status = await auth.handleCallback('code-123', state);
    expect(status).toEqual({ connected: true, configured: true, user: { name: 'Listener', product: 'premium' } });
    expect(tokenRequests).toHaveLength(1);
    expect(auth.hasRefreshToken()).toBe(true);

    const row = db.prepare('SELECT * FROM spotify_auth WHERE id = 1').get() as {
      access_token: string;
      refresh_token: string;
      user_name: string;
      user_product: string;
    };
    expect(row.access_token).toBe('access-1');
    expect(row.refresh_token).toBe('refresh-1');
    expect(row.user_name).toBe('Listener');
    expect(row.user_product).toBe('premium');
    expect(auth.redirectUri()).toBe('http://127.0.0.1:4545/api/spotify/callback');
  });

  it('rejects an unknown/replayed state', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(500, {}));
    const { auth } = makeAuth(fetch);
    await expect(auth.handleCallback('code', 'not-a-state')).rejects.toThrow(/state/i);
  });

  it('serves a cached token and refreshes only when forced', async () => {
    let tokenCalls = 0;
    const { fetch } = fakeFetch(async (url) => {
      if (url.pathname === '/api/token') {
        tokenCalls++;
        return jsonResponse(200, { access_token: 'fresh', expires_in: 3600 });
      }
      return jsonResponse(404, {});
    });
    const { auth } = makeAuth(fetch);
    auth.storeTokens({ access_token: 'still-valid', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' });

    await expect(auth.getAccessToken()).resolves.toBe('still-valid');
    expect(tokenCalls).toBe(0);
    await expect(auth.getAccessToken(true)).resolves.toBe('fresh');
    expect(tokenCalls).toBe(1);
    // Refresh response omitted refresh_token — the old one must survive.
    expect(auth.hasRefreshToken()).toBe(true);
  });

  it('serializes concurrent refreshes into a single token request', async () => {
    let tokenCalls = 0;
    const { fetch } = fakeFetch(async (url) => {
      if (url.pathname === '/api/token') {
        tokenCalls++;
        await new Promise((r) => setTimeout(r, 25));
        return jsonResponse(200, { access_token: `refreshed-${tokenCalls}`, expires_in: 3600 });
      }
      return jsonResponse(404, {});
    });
    const { auth } = makeAuth(fetch);
    auth.storeTokens({ access_token: 'expired', token_type: 'Bearer', expires_in: -10, refresh_token: 'rt' });

    const results = await Promise.all(Array.from({ length: 8 }, () => auth.getAccessToken()));
    expect(results).toEqual(Array(8).fill('refreshed-1'));
    expect(tokenCalls).toBe(1);
  });

  it('clears the session on invalid_grant', async () => {
    const { fetch } = fakeFetch(async (url) => {
      if (url.pathname === '/api/token') return jsonResponse(400, { error: 'invalid_grant' });
      return jsonResponse(404, {});
    });
    const { auth } = makeAuth(fetch);
    auth.storeTokens({ access_token: 'expired', token_type: 'Bearer', expires_in: -10, refresh_token: 'rt' });

    await expect(auth.getAccessToken()).rejects.toMatchObject({ name: 'SpotifyAuthError', code: 'invalid_grant' });
    expect(auth.status()).toEqual({ connected: false, configured: true });
    expect(auth.hasRefreshToken()).toBe(false);
  });

  it('reports not_connected and logs out', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(500, {}));
    const { auth } = makeAuth(fetch);
    expect(auth.status()).toEqual({ connected: false, configured: true });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(SpotifyAuthError);

    auth.storeTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 60, refresh_token: 'r' });
    expect(auth.status().connected).toBe(true);
    auth.logout();
    expect(auth.status()).toEqual({ connected: false, configured: true });
  });
});
