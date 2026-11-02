import { clientLog } from '../clientLog';
import type { Track } from '@liner/shared';
import type { Engine } from './engine';
import { detectEnded, extrapolate, spotifyIdOf, type Snap } from './sdkState';

// ---------- minimal typings for the Web Playback SDK (no @types dependency) ----------
interface SdkTrack { id: string | null; uri: string; linked_from?: { id: string | null; uri: string | null } }
interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  loading?: boolean;
  track_window: { current_track: SdkTrack; previous_tracks: SdkTrack[] };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
  activateElement?(): Promise<void>;
}
declare global {
  interface Window {
    Spotify?: { Player: new (o: { name: string; getOAuthToken(cb: (t: string) => void): void; volume?: number; enableMediaSession?: boolean }) => SdkPlayer };
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

// ---------- token (short-lived; the server refreshes against Spotify) ----------
let tokenCache: { token: string; expiresAt: number } | null = null;
export async function spotifyToken(force = false): Promise<string> {
  if (!force && tokenCache && tokenCache.expiresAt - Date.now() > 60_000) return tokenCache.token;
  const res = await fetch('/api/spotify/token');
  if (!res.ok) throw new Error(res.status === 401 ? 'Spotify is not connected' : `Spotify token failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_at?: number };
  tokenCache = { token: j.access_token, expiresAt: j.expires_at && j.expires_at > Date.now() ? j.expires_at : Date.now() + 5 * 60_000 };
  return j.access_token;
}

let sdkScript: Promise<void> | null = null;
function loadSdkScript(): Promise<void> {
  if (window.Spotify) return Promise.resolve();
  sdkScript ??= new Promise<void>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.async = true;
    s.onerror = () => { sdkScript = null; reject(new Error('Could not load the Spotify player (offline or blocked)')); };
    document.head.appendChild(s);
  });
  return sdkScript;
}

export type SdkPhase = 'off' | 'loading' | 'ready' | 'error';
export interface SdkStatus { phase: SdkPhase; deviceId: string | null; error?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spotify playback inside this browser tab, driven through the Web Playback SDK. */
export class SpotifySdkEngine implements Engine {
  private player: SdkPlayer | null = null;
  private status: SdkStatus = { phase: 'off', deviceId: null };
  private statusFn: (s: SdkStatus) => void = () => {};
  private readyWaiters: { resolve(id: string): void; reject(e: Error): void }[] = [];
  private starting: Promise<void> | null = null;

  private cur: { track: Track; startMs: number } | null = null;
  private seq = 0;
  private snap: Snap | null = null;
  private pos = { ms: 0, at: 0, playing: false };
  private volume = 0.7;
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private syncFn: (pos: number, playing: boolean) => void = () => {};
  private poll: ReturnType<typeof setInterval> | null = null;
  /** After load(), ignore "paused" events until playback really started (they describe an earlier play of the same track). */
  private awaitUntil = 0;

  constructor(readonly deviceName: string) {}

  onStatus(fn: (s: SdkStatus) => void) { this.statusFn = fn; fn(this.status); }
  get deviceId() { return this.status.deviceId; }
  get phase() { return this.status.phase; }

  private setStatus(patch: Partial<SdkStatus>) {
    const before = this.status.phase;
    this.status = { ...this.status, ...patch };
    if (patch.phase && (patch.phase !== before || patch.error)) {
      clientLog(patch.phase === 'error' ? 'error' : 'info', `spotify sdk: ${patch.phase}${patch.error ? ` — ${patch.error}` : ''}`, { deviceId: this.status.deviceId });
    }
    this.statusFn(this.status);
  }

  /** Load the SDK script and register this tab as a Spotify device (idempotent). */
  activate(): Promise<void> {
    this.starting ??= this.boot();
    return this.starting;
  }

  private async boot(): Promise<void> {
    this.setStatus({ phase: 'loading', error: undefined });
    try {
      await loadSdkScript();
      const P = window.Spotify?.Player;
      if (!P) throw new Error('Spotify player unavailable');
      const player = new P({ name: this.deviceName, getOAuthToken: (cb) => { void spotifyToken().then(cb, () => cb('')); }, volume: this.volume, enableMediaSession: false });
      this.player = player;
      const fail = (msg: string) => {
        this.setStatus({ phase: 'error', error: msg });
        const w = this.readyWaiters.splice(0);
        for (const x of w) x.reject(new Error(msg));
        if (this.cur) this.errorFn(msg);
      };
      player.addListener('ready', (({ device_id }: { device_id: string }) => {
        this.setStatus({ phase: 'ready', deviceId: device_id, error: undefined });
        for (const x of this.readyWaiters.splice(0)) x.resolve(device_id);
      }) as never);
      player.addListener('not_ready', (() => this.setStatus({ phase: 'loading', deviceId: null })) as never);
      player.addListener('initialization_error', (({ message }: { message: string }) => {
        // Brave ships with Widevine (the DRM Spotify needs) switched off.
        const brave = 'brave' in navigator;
        fail(brave
          ? 'Brave has Widevine switched off — turn on "Widevine" in brave://settings/extensions, restart Brave, then reload rune'
          : `This browser cannot play Spotify (${message}) — it needs Widevine DRM enabled`);
      }) as never);
      player.addListener('authentication_error', (({ message }: { message: string }) => fail(`Spotify sign-in problem (${message})`)) as never);
      player.addListener('account_error', (() => fail('Spotify Premium is required to play in the browser')) as never);
      player.addListener('playback_error', (({ message }: { message: string }) => { if (this.cur) this.errorFn(`Spotify could not play this (${message})`); }) as never);
      player.addListener('player_state_changed', ((s: SdkState | null) => this.onState(s)) as never);
      const ok = await player.connect();
      if (!ok) throw new Error('Could not connect to Spotify');
      this.poll = setInterval(() => { if (this.cur) void this.player?.getCurrentState().then((s) => this.onState(s), () => undefined); }, 4000);
    } catch (e) {
      this.starting = null;
      this.setStatus({ phase: 'error', error: (e as Error).message });
      throw e;
    }
  }

  private ensureReady(): Promise<string> {
    if (this.status.phase === 'error') return Promise.reject(new Error(this.status.error ?? 'Spotify player unavailable'));
    if (this.status.deviceId) return Promise.resolve(this.status.deviceId);
    const wait = new Promise<string>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      setTimeout(() => reject(new Error('The Spotify player is taking too long to start')), 15_000);
    });
    void this.activate().catch(() => undefined);
    return wait;
  }

  // ---------- state from the SDK ----------
  private onState(s: SdkState | null) {
    const cur = this.cur;
    if (!cur) return;
    if (!s) {
      // device lost (playback moved to another device)
      if (this.pos.playing) { this.pos = { ms: this.position() ?? this.pos.ms, at: Date.now(), playing: false }; this.syncFn(this.pos.ms, false); }
      return;
    }
    const t = s.track_window.current_track;
    const want = spotifyIdOf(cur.track.id);
    if (t.id !== want && t.linked_from?.id !== want) return; // an older track's event: ignore
    if (Date.now() < this.awaitUntil) {
      if (s.paused) return;
      this.awaitUntil = 0;
    }
    const next: Snap = {
      id: want,
      positionMs: s.position,
      durationMs: s.duration || cur.track.durationMs,
      playing: !s.paused,
      at: Date.now(),
      previousIds: s.track_window.previous_tracks.flatMap((p) => [p.id, p.linked_from?.id]).filter((x): x is string => !!x),
    };
    const ended = detectEnded(this.snap, next);
    this.snap = next;
    this.pos = { ms: next.positionMs, at: next.at, playing: next.playing };
    if (ended) {
      this.pos = { ms: 0, at: next.at, playing: false };
      this.snap = null;
      this.endedFn();
      return;
    }
    this.syncFn(next.positionMs, next.playing);
  }

  // ---------- Engine ----------
  load(track: Track, startMs: number, autoplay: boolean) {
    const seq = ++this.seq;
    this.cur = { track, startMs };
    this.snap = null;
    this.pos = { ms: startMs, at: Date.now(), playing: false };
    this.awaitUntil = autoplay ? Date.now() + 6000 : 0;
    // Safari/Chrome autoplay rules: this runs inside the user's click, before any await.
    void this.player?.activateElement?.().catch(() => undefined);
    void this.start(track, startMs, autoplay, seq);
  }

  private async start(track: Track, startMs: number, autoplay: boolean, seq: number) {
    try {
      const deviceId = await this.ensureReady();
      if (seq !== this.seq) return;
      const uri = track.spotifyUri ?? `spotify:track:${spotifyIdOf(track.id)}`;
      await this.playOnDevice(deviceId, uri, startMs, () => seq !== this.seq);
      if (seq !== this.seq) return;
      if (!autoplay) await this.player?.pause().catch(() => undefined);
    } catch (e) {
      if (seq === this.seq) this.errorFn((e as Error).message);
    }
  }

  /** Start one track on this tab's device via the Web API (the SDK has no "play this" call). */
  private async playOnDevice(deviceId: string, uri: string, startMs: number, stale: () => boolean) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (stale()) return;
      const token = await spotifyToken(attempt > 0 && this.lastStatus === 401);
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(startMs)) }),
      });
      this.lastStatus = res.status;
      if (res.ok) return;
      if (res.status === 404) { // device not known to Spotify yet: transfer playback to it, then retry
        await fetch('https://api.spotify.com/v1/me/player', {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ device_ids: [deviceId], play: false }),
        }).catch(() => undefined);
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 401) continue;
      if (res.status === 429) { await sleep(Math.min(5000, Number(res.headers.get('retry-after') ?? 1) * 1000)); continue; }
      if (res.status === 403) throw new Error('Spotify Premium is required to play in the browser');
      throw new Error(`Spotify refused to play this (${res.status})`);
    }
    throw new Error('Spotify did not start playing — try again');
  }
  private lastStatus = 0;

  play() {
    const cur = this.cur;
    if (!cur) return;
    const resumeAt = this.position() ?? this.pos.ms;
    this.pos = { ms: resumeAt, at: Date.now(), playing: true };
    void (async () => {
      const state = await this.player?.getCurrentState().catch(() => null);
      const here = state && (state.track_window.current_track.id === spotifyIdOf(cur.track.id) || state.track_window.current_track.linked_from?.id === spotifyIdOf(cur.track.id));
      if (here) await this.player?.resume();
      else this.load(cur.track, resumeAt, true); // device lost the track (e.g. another device took over): start it again
    })().catch((e: Error) => this.errorFn(e.message));
  }
  pause() {
    this.pos = { ms: this.position() ?? this.pos.ms, at: Date.now(), playing: false };
    void this.player?.pause().catch(() => undefined);
  }
  seek(ms: number) {
    this.pos = { ms, at: Date.now(), playing: this.pos.playing };
    if (this.snap) this.snap = { ...this.snap, positionMs: ms, at: Date.now() };
    void this.player?.seek(Math.max(0, Math.round(ms))).catch(() => undefined);
  }
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v / 100));
    void this.player?.setVolume(this.volume).catch(() => undefined);
  }
  position(): number | null {
    if (!this.cur) return null;
    const { ms, at, playing } = this.pos;
    const dur = this.snap?.durationMs ?? this.cur.track.durationMs;
    return extrapolate({ id: '', positionMs: ms, durationMs: dur, playing, at, previousIds: [] }, Date.now());
  }
  stop() {
    this.seq++;
    this.cur = null;
    this.snap = null;
    this.pos = { ms: 0, at: Date.now(), playing: false };
    void this.player?.pause().catch(() => undefined);
  }
  onEnded(fn: () => void) { this.endedFn = fn; }
  onError(fn: (m: string) => void) { this.errorFn = fn; }
  onSync(fn: (pos: number, playing: boolean) => void) { this.syncFn = fn; }

  dispose() {
    if (this.poll) clearInterval(this.poll);
    this.player?.disconnect();
  }
}
