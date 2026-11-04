// Spotify Authorization Code + PKCE.
//
// Spotify only permits loopback redirect URIs over plain http, so the one-time
// login must happen in a browser on the PC that runs the server. The server keeps
// the refresh token; every other device (phone PWA included) asks this server for
// short-lived access tokens via GET /api/spotify/token and never sees the refresh
// token. There is deliberately no client secret: PKCE replaces it.
import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';
import type { Config } from '../config.js';
import { HttpError, type FetchLike } from './fetch.js';
import type { SpotifyUser } from './api.js';
import { ensureSpotifySchema } from './schema.js';

export { ensureSpotifySchema } from './schema.js';

export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-library-read',
  'user-library-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read',
].join(' ');

export interface SpotifyEndpoints {
  accounts: string;
  api: string;
}

export const DEFAULT_SPOTIFY_ENDPOINTS: SpotifyEndpoints = {
  accounts: 'https://accounts.spotify.com',
  api: 'https://api.spotify.com/v1',
};

export interface SpotifyAuthOptions {
  /** Injected for tests / the simulated-server self-check. */
  fetch?: FetchLike;
  endpoints?: Partial<SpotifyEndpoints>;
  scope?: string;
  /** Defaults to http://127.0.0.1:<cfg.port>/api/spotify/callback */
  redirectUri?: string;
  now?: () => number;
  /** Refresh this long before the access token expires (default 60 s). */
  expirySkewMs?: number;
  pendingTtlMs?: number;
}

export class SpotifyAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SpotifyAuthError';
  }
}

export interface SpotifyStatus {
  connected: boolean;
  /** False only for the stand-in answer when no Spotify client id is configured. */
  configured: boolean;
  user?: { name: string; product: string };
}

// ---------- PKCE (RFC 7636) ----------

/** 43-character base64url verifier (32 random bytes). */
export function createPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** S256 challenge = BASE64URL(SHA256(ASCII(verifier))), 43 chars, no padding. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

// ---------- tokens ----------

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

interface AuthRow {
  id: number;
  access_token: string | null;
  refresh_token: string | null;
  token_type: string | null;
  scope: string | null;
  expires_at: number;
  user_name: string | null;
  user_product: string | null;
  updated_at: number;
}

interface PendingLogin {
  verifier: string;
  redirectUri: string;
  createdAt: number;
}

export class SpotifyAuth {
  private readonly db: Db;
  private readonly cfg: Config;
  private readonly fetchImpl: FetchLike;
  private readonly endpoints: SpotifyEndpoints;
  private readonly scope: string;
  private readonly now: () => number;
  private readonly expirySkewMs: number;
  private readonly pendingTtlMs: number;
  private readonly explicitRedirectUri?: string;
  private readonly pending = new Map<string, PendingLogin>();
  /** Shared in-flight refresh so concurrent 401s/expiry checks trigger one request. */
  private refreshPromise: Promise<AuthRow> | null = null;

  constructor(db: Db, cfg: Config, opts: SpotifyAuthOptions = {}) {
    ensureSpotifySchema(db);
    this.db = db;
    this.cfg = cfg;
    this.fetchImpl = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.endpoints = { ...DEFAULT_SPOTIFY_ENDPOINTS, ...opts.endpoints };
    this.scope = opts.scope ?? SPOTIFY_SCOPES;
    this.now = opts.now ?? Date.now;
    this.expirySkewMs = opts.expirySkewMs ?? 60_000;
    this.pendingTtlMs = opts.pendingTtlMs ?? 10 * 60_000;
    this.explicitRedirectUri = opts.redirectUri;
  }

  get clientId(): string | undefined {
    return this.cfg.spotifyClientId;
  }

  get configured(): boolean {
    return !!this.cfg.spotifyClientId;
  }

  redirectUri(): string {
    return this.explicitRedirectUri ?? `http://127.0.0.1:${this.cfg.port}/api/spotify/callback`;
  }

  /** Authorization URL with a fresh verifier/state. Redirect the PC browser here. */
  loginUrl(redirectOverride?: string): string {
    const clientId = this.clientId;
    if (!clientId) {
      throw new SpotifyAuthError('Spotify is not configured: set spotifyClientId in server/config.json (or config).');
    }
    this.prunePending();
    const verifier = createPkceVerifier();
    const state = randomBytes(16).toString('base64url');
    const redirectUri = redirectOverride ?? this.redirectUri();
    this.pending.set(state, { verifier, redirectUri, createdAt: this.now() });

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: this.scope,
      code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier),
    });
    return `${this.endpoints.accounts}/authorize?${params.toString()}`;
  }

  /** Exchange ?code + ?state for tokens, persist them, cache the profile. */
  async handleCallback(code: string, state: string): Promise<SpotifyStatus> {
    const clientId = this.clientId;
    if (!clientId) throw new SpotifyAuthError('Spotify is not configured.');
    const entry = this.pending.get(state);
    if (!entry) throw new SpotifyAuthError('Unknown or expired Spotify login state; start the login again.');
    this.pending.delete(state);
    if (this.now() - entry.createdAt > this.pendingTtlMs) {
      throw new SpotifyAuthError('Spotify login state expired; start the login again.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: entry.redirectUri,
      client_id: clientId,
      code_verifier: entry.verifier,
    });
    const tokens = await this.tokenRequest(body);
    this.saveTokens(tokens);

    try {
      const user = await this.fetchProfile(tokens.access_token);
      this.saveUser(user);
    } catch {
      // Profile is only cosmetic for /status; tokens are already valid.
    }
    return this.status();
  }

  /** Scopes the user actually granted (older logins lack newer ones until they reconnect). */
  grantedScopes(): string[] {
    const row = this.db.prepare('SELECT scope FROM spotify_auth WHERE id = 1').get() as { scope: string | null } | undefined;
    return (row?.scope ?? '').split(/\s+/).filter(Boolean);
  }

  status(): SpotifyStatus {
    const row = this.load();
    if (!row?.access_token || !row?.refresh_token) return { connected: false, configured: true };
    const name = row.user_name;
    return name
      ? { connected: true, configured: true, user: { name, product: row.user_product ?? '' } }
      : { connected: true, configured: true };
  }

  /** Access token for the browser Web Playback SDK, refreshed when needed. */
  async tokenPayload(): Promise<{ access_token: string; token_type: 'Bearer'; expires_at: number }> {
    const accessToken = await this.getAccessToken();
    const row = this.load();
    return { access_token: accessToken, token_type: 'Bearer', expires_at: row?.expires_at ?? 0 };
  }

  async getAccessToken(force = false): Promise<string> {
    const row = this.load();
    if (!row?.access_token || !row.refresh_token) {
      throw new SpotifyAuthError('Not connected to Spotify.', 'not_connected');
    }
    const fresh = row.expires_at - this.now() > this.expirySkewMs;
    if (!force && fresh) return row.access_token;

    const refreshed = await this.refreshShared(row.refresh_token);
    if (!refreshed.access_token) throw new SpotifyAuthError('Spotify refresh returned no access token.');
    return refreshed.access_token;
  }

  logout(): void {
    this.pending.clear();
    this.db.prepare('DELETE FROM spotify_auth').run();
  }

  /** Exposed for tests and the simulated-server self-check. */
  storeTokens(tokens: TokenResponse): void {
    this.saveTokens(tokens);
  }

  /** Current refresh token count is always 0/1 (single-user); handy for assertions. */
  hasRefreshToken(): boolean {
    return !!this.load()?.refresh_token;
  }

  // ---------- internals ----------

  private refreshShared(refreshToken: string): Promise<AuthRow> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh(refreshToken).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async doRefresh(refreshToken: string): Promise<AuthRow> {
    const clientId = this.clientId;
    if (!clientId) throw new SpotifyAuthError('Spotify is not configured.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    try {
      const tokens = await this.tokenRequest(body);
      this.saveTokens(tokens);
      const row = this.load();
      if (!row) throw new SpotifyAuthError('Failed to persist refreshed Spotify tokens.');
      return row;
    } catch (err) {
      if (err instanceof SpotifyAuthError && err.code === 'invalid_grant') this.logout();
      throw err;
    }
  }

  private async tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const res = await this.fetchImpl(`${this.endpoints.accounts}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
    const text = await res.text();
    let data: Partial<TokenResponse> = {};
    try {
      data = text ? (JSON.parse(text) as Partial<TokenResponse>) : {};
    } catch {
      // Non-JSON error page.
    }
    if (!res.ok || data.error) {
      throw new SpotifyAuthError(
        `Spotify token request failed (${res.status}): ${data.error_description ?? data.error ?? text.slice(0, 200)}`,
        data.error ?? `http_${res.status}`,
      );
    }
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new SpotifyAuthError('Spotify token response was missing access_token/expires_in.');
    }
    return data as TokenResponse;
  }

  private saveTokens(tokens: TokenResponse): void {
    const existing = this.load();
    const refreshToken = tokens.refresh_token ?? existing?.refresh_token ?? null;
    const expiresAt = this.now() + tokens.expires_in * 1000;
    this.db
      .prepare(
        `INSERT INTO spotify_auth
           (id, access_token, refresh_token, token_type, scope, expires_at, user_name, user_product, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           token_type = excluded.token_type,
           scope = excluded.scope,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        tokens.access_token,
        refreshToken,
        tokens.token_type ?? 'Bearer',
        tokens.scope ?? existing?.scope ?? null,
        expiresAt,
        this.now(),
      );
  }

  private async fetchProfile(accessToken: string): Promise<SpotifyUser> {
    const res = await this.fetchImpl(`${this.endpoints.api}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new HttpError(`Spotify /me failed (${res.status})`, res.status, await res.text());
    return (await res.json()) as SpotifyUser;
  }

  private saveUser(user: SpotifyUser): void {
    const name = user.display_name || user.id;
    if (!name) return;
    this.db
      .prepare('UPDATE spotify_auth SET user_name = ?, user_product = ? WHERE id = 1')
      .run(name, user.product ?? '');
  }

  private load(): AuthRow | undefined {
    return this.db.prepare('SELECT * FROM spotify_auth WHERE id = 1').get() as AuthRow | undefined;
  }

  private prunePending(): void {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

// ---------- routes ----------

export interface SpotifyRouteOptions extends SpotifyAuthOptions {
  /** Override the object used by routes (tests may pre-seed tokens). */
  auth?: SpotifyAuth;
  /** Fired after a successful login callback; the server starts a library sync. */
  onLogin?: () => void;
}

/**
 * Registers the Spotify HTTP surface. Full paths are used because the main
 * session mounts module routes on the root Fastify instance under /api.
 *
 * Returned: the auth instance (so the caller can build the API client/zones).
 */
export function registerSpotifyRoutes(
  app: FastifyInstance,
  db: Db,
  cfg: Config,
  opts: SpotifyRouteOptions = {},
): SpotifyAuth {
  ensureSpotifySchema(db);
  const auth = opts.auth ?? new SpotifyAuth(db, cfg, opts);

  app.get('/api/spotify/login', async (req, reply) => {
    try {
      // Spotify allows http only for loopback; from other devices (the Mac, the iPhone)
      // log in through the HTTPS Tailscale address instead — it must also be registered
      // as a redirect URI in the Spotify dashboard.
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
      const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
      const publicUrl = cfg.publicUrl?.replace(/\/$/, '');
      const redirect = !loopback && publicUrl ? `${publicUrl}/api/spotify/callback` : undefined;
      return reply.redirect(auth.loginUrl(redirect));
    } catch (err) {
      return errorReply(reply, 500, err);
    }
  });

  app.get('/api/spotify/callback', async (req, reply) => {
    const query = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (query.error) {
      return reply.code(400).send({ error: query.error, description: query.error_description });
    }
    if (!query.code || !query.state) {
      return reply.code(400).send({ error: 'missing code or state' });
    }
    try {
      await auth.handleCallback(query.code, query.state);
      // Do not await the sync: the browser goes straight to the app while the
      // library fills in behind it.
      opts.onLogin?.();
      return reply.redirect('/');
    } catch (err) {
      return errorReply(reply, 400, err);
    }
  });

  app.get('/api/spotify/status', async () => auth.status());

  app.post('/api/spotify/logout', async () => {
    auth.logout();
    return { ok: true };
  });

  app.get('/api/spotify/token', async (_req, reply) => {
    try {
      return await auth.tokenPayload();
    } catch (err) {
      if (err instanceof SpotifyAuthError && err.code === 'not_connected') {
        return reply.code(401).send({ error: 'not_connected' });
      }
      return errorReply(reply, 502, err);
    }
  });

  return auth;
}

function errorReply(reply: FastifyReply, status: number, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(status).send({ error: message });
}
