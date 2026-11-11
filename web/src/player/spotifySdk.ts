import { clientLog } from '../clientLog';
import type { ClientEvent, Track } from '@liner/shared';
import type { Engine } from './engine';
import { detectEnded, extrapolate, shouldReport, spotifyIdOf, type ReportState, type Snap } from './sdkState';

// ---------- minimal typings for the Web Playback SDK (no @types dependency) ----------
interface SdkImage { url: string; width?: number | null; height?: number | null }
interface SdkArtist { name: string; uri: string }
interface SdkAlbum { name: string; uri: string; images?: SdkImage[] }
interface SdkTrack {
  id: string | null;
  uri: string;
  name?: string;
  duration_ms?: number;
  artists?: SdkArtist[];
  album?: SdkAlbum;
  linked_from?: { id: string | null; uri: string | null };
}
interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  loading?: boolean;
  shuffle?: boolean;
  repeat_mode?: number;
  track_window: { current_track: SdkTrack; previous_tracks: SdkTrack[]; next_tracks?: SdkTrack[] };
}
interface SdkPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: never) => void): boolean;
  getCurrentState(): Promise<SdkState | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  nextTrack?(): Promise<void>;
  setVolume(v: number): Promise<void>;
  getVolume?(): Promise<number>;
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

export type SdkStateReport = Extract<ClientEvent, { type: 'sdk-state' }>;
/** Where the SDK sends its local playback reports (wired to the shared websocket by remote.ts). */
let sdkReporter: ((report: SdkStateReport) => void) | null = null;
export function setSdkReporter(fn: ((report: SdkStateReport) => void) | null): void {
  sdkReporter = fn;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** After load(): how long SDK positions are checked against where the new track can be. */
const STALE_WINDOW_MS = 8000;
const STALE_SLACK_MS = 3000;
/** Spotify songs sent along with the playing one, so Spotify loads ahead and Next is near-instant. */
const LOOKAHEAD = 20;

const sdkIds = (t: SdkTrack | undefined): string[] => (t ? [t.id, t.linked_from?.id].filter((x): x is string => !!x) : []);
const isTrack = (t: SdkTrack | undefined, id: string) => sdkIds(t).includes(id);

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
  private volume = 1;
  private endedFn: () => void = () => {};
  private errorFn: (m: string) => void = () => {};
  private syncFn: (pos: number, playing: boolean) => void = () => {};
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Slow local poll that keeps the server's synthetic playback answer fresh (free: SDK only). */
  private reportPoll: ReturnType<typeof setInterval> | null = null;
  /** Last report sent to the server (for throttling). */
  private report: ReportState | null = null;
  /** Whether the SDK last reported its device as active (drives the free heartbeat poll). */
  private reportActive = false;
  /** After load(), ignore "paused" events until playback really started (they describe an earlier play of the same track). */
  private awaitUntil = 0;
  private loadAt = 0;
  private loadStartMs = 0;
  private stateLogs = 0;
  /** Spotify ids of the list last sent to Spotify (playing song first, then the look-ahead). */
  private window: string[] = [];
  /** Latest state from the SDK, whatever song it describes, and when it came. */
  private last: { s: SdkState; at: number } | null = null;
  /** The song whose end was already reported because Spotify moved on by itself. */
  private advancedFrom: string | null = null;
  /** Spotify's own shuffle/repeat would reorder or repeat the list we send: switched off once per session. */
  private modesChecked = false;

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
      this.poll = setInterval(() => { if (this.cur) void this.readState(); }, 4000);
      // SDK calls are local (no Web API quota): while this device is the active one, keep the
      // server's report fresh even when this tab has no rune queue loaded (it may be driven
      // from another rune client as a Connect zone).
      this.reportPoll = setInterval(() => {
        if (!this.reportActive || this.cur) return;
        void this.readState();
      }, 10_000);
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
  /**
   * Local SDK read (no quota). The volume is re-read too: another rune client may have changed it
   * through Spotify, and the report must not keep announcing the old level.
   */
  private async readState(): Promise<void> {
    const p = this.player;
    if (!p) return;
    try {
      const v = await p.getVolume?.();
      if (typeof v === 'number' && Number.isFinite(v)) this.volume = clamp01(v);
    } catch { /* keep the known volume */ }
    try {
      this.onState(await p.getCurrentState());
    } catch { /* next tick */ }
  }

  /**
   * Tell the server what this tab's Spotify device is doing. Runs whatever this tab's own
   * queue does, because the device can also be driven from another rune client.
   */
  private reportSdkState(s: SdkState | null): void {
    const reporter = sdkReporter;
    const deviceId = this.status.deviceId;
    if (!reporter || !deviceId) return;
    const now = Date.now();
    if (!s) {
      // Device no longer active (playback moved elsewhere): say so once.
      if (this.reportActive) {
        reporter({ type: 'sdk-state', deviceId, active: false });
        this.report = null;
        this.reportActive = false;
      }
      return;
    }
    const t = s.track_window.current_track;
    if (!t || !t.id) return; // local files have no Spotify id: nothing usable as a synthetic answer
    const track = {
      id: t.id,
      uri: t.uri,
      name: t.name ?? '',
      durationMs: s.duration || t.duration_ms || 0,
      artists: (t.artists ?? []).map((a) => ({ name: a.name, uri: a.uri })),
      album: {
        name: t.album?.name ?? '',
        uri: t.album?.uri ?? '',
        images: (t.album?.images ?? []).map((i) => ({ url: i.url, width: i.width ?? null, height: i.height ?? null })),
      },
    };
    const next: ReportState = {
      active: true,
      trackId: track.id,
      playing: !s.paused,
      positionMs: Math.max(0, s.position ?? 0),
      shuffle: !!s.shuffle,
      repeat: s.repeat_mode === 1 ? 1 : s.repeat_mode === 2 ? 2 : 0,
      volume: clamp01(this.volume),
      at: now,
    };
    this.reportActive = true;
    if (!shouldReport(this.report, next, now)) return;
    this.report = next;
    reporter({
      type: 'sdk-state',
      deviceId,
      active: true,
      playing: next.playing,
      positionMs: next.positionMs,
      durationMs: track.durationMs,
      track,
      shuffle: next.shuffle,
      repeat: next.repeat,
      volume: next.volume,
    });
  }

  private onState(s: SdkState | null) {
    // Report to the server first: this is needed even when this tab drives no rune queue.
    this.reportSdkState(s);
    const cur = this.cur;
    if (!cur) return;
    if (!s) {
      // device lost (playback moved to another device)
      if (this.pos.playing) { this.pos = { ms: this.position() ?? this.pos.ms, at: Date.now(), playing: false }; this.syncFn(this.pos.ms, false); }
      return;
    }
    const t = s.track_window.current_track;
    const want = spotifyIdOf(cur.track.id);
    if (t.id !== want && t.linked_from?.id !== want) {
      // Spotify moved on to the next song of the list we sent (this one ended): report the end once;
      // the queue then asks for that next song, which load() picks up without a new request.
      const at = this.window.indexOf(want);
      const movedOn = at >= 0 && sdkIds(t).includes(this.window[at + 1] ?? '') && s.track_window.previous_tracks.some((p) => isTrack(p, want));
      if (movedOn && this.advancedFrom !== want && this.pos.playing) {
        this.advancedFrom = want;
        this.snap = null;
        this.last = { s, at: Date.now() }; // what Spotify is playing now: load() follows it
        this.endedFn();
      }
      return; // otherwise an older track's event: ignore
    }
    // Right after a track change the SDK can still report the PREVIOUS song's position under the
    // new song: ignore positions far from where the new song can be, or the bar jumps back.
    const sinceLoad = Date.now() - this.loadAt;
    if (sinceLoad < STALE_WINDOW_MS) {
      const expected = this.loadStartMs + (s.paused ? 0 : sinceLoad);
      if (this.stateLogs < 4) {
        this.stateLogs++;
        clientLog('info', 'spotify sdk: state after load', { track: want, position: s.position, paused: s.paused, expected, sinceLoad });
      }
      if (Math.abs(s.position - expected) > STALE_SLACK_MS + sinceLoad) return;
    }
    if (Date.now() < this.awaitUntil) {
      if (s.paused) return;
      this.awaitUntil = 0;
    }
    // only states that passed the checks above may steer a fast switch
    this.last = { s, at: Date.now() };
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
  load(track: Track, startMs: number, autoplay: boolean, upcoming: Track[] = []) {
    if (autoplay && startMs === 0 && this.fastSwitch(track)) return;
    this.last = null; // describes the song we are leaving
    const seq = ++this.seq;
    this.cur = { track, startMs };
    this.advancedFrom = null;
    this.snap = null;
    this.pos = { ms: startMs, at: Date.now(), playing: false };
    this.awaitUntil = autoplay ? Date.now() + 6000 : 0;
    this.loadAt = Date.now();
    this.loadStartMs = startMs;
    this.stateLogs = 0;
    // Safari/Chrome autoplay rules: this runs inside the user's click, before any await.
    void this.player?.activateElement?.().catch(() => undefined);
    // A paused load (a handoff of a paused song to this tab) asks Spotify for nothing yet: the Web API play call makes
    // this tab the account's active device and silences whatever else is playing on it (Soloist, a phone). play() loads
    // the song for real when Play is pressed, from where the position stands then.
    if (!autoplay) {
      clientLog('info', 'spotify sdk: load deferred (paused)', { track: track.id, startMs });
      return;
    }
    void this.start(track, startMs, autoplay, seq, upcoming.filter((t) => t.source === 'spotify').slice(0, LOOKAHEAD));
  }

  /**
   * Switch without a new play request when Spotify already has the song: it moved there by itself
   * (end of the previous song) or it is next in the list we sent (Next button) — both near-instant,
   * because Spotify loaded it ahead. False = do a normal load.
   */
  private fastSwitch(track: Track): boolean {
    const id = spotifyIdOf(track.id);
    const last = this.last;
    if (!this.player || !last || Date.now() - last.at > 4_000 || !this.window.includes(id)) return false;
    const tw = last.s.track_window;
    // following only applies to a song Spotify moved to by itself (not a restart of the same song)
    const adopt = isTrack(tw.current_track, id) && !!this.cur && spotifyIdOf(this.cur.track.id) !== id;
    const skip = !adopt && isTrack(tw.next_tracks?.[0], id) && !!this.player.nextTrack;
    if (!adopt && !skip) return false;
    // after a skip, Spotify is still switching: until it reports the new song, nothing may follow the old state
    // (Previous pressed right after Next would otherwise "follow" the song being left and send nothing)
    this.last = null;
    this.seq++;
    this.cur = { track, startMs: 0 };
    this.snap = null;
    this.advancedFrom = null;
    this.stateLogs = 0;
    if (adopt) {
      // Spotify is already playing it: just follow along from where it is
      this.pos = { ms: last.s.paused ? last.s.position : last.s.position + (Date.now() - last.at), at: Date.now(), playing: !last.s.paused };
      this.awaitUntil = 0;
      this.loadAt = 0;
      if (last.s.paused) void this.player.resume().catch(() => undefined);
    } else {
      this.pos = { ms: 0, at: Date.now(), playing: false };
      this.awaitUntil = Date.now() + 6000;
      this.loadAt = Date.now();
      this.loadStartMs = 0;
      void this.player.nextTrack!().catch(() => undefined);
    }
    clientLog('info', `spotify sdk: ${adopt ? 'followed' : 'skipped'} to the next song`, { track: id });
    return true;
  }

  private async start(track: Track, startMs: number, autoplay: boolean, seq: number, upcoming: Track[] = []) {
    try {
      clientLog('info', 'spotify sdk: load', { track: track.id, startMs, autoplay, phase: this.status.phase, ahead: upcoming.length });
      const deviceId = await this.ensureReady();
      if (seq !== this.seq) return;
      const uriOf = (t: Track) => t.spotifyUri ?? `spotify:track:${spotifyIdOf(t.id)}`;
      const list = [track, ...upcoming];
      this.window = list.map((t) => spotifyIdOf(t.id));
      await this.playOnDevice(deviceId, list.map(uriOf), startMs, () => seq !== this.seq);
      if (seq !== this.seq) return;
      // Every load, a one-song queue too: Spotify's own repeat "context" would loop the single song it was sent.
      void this.ensurePlainOrder(deviceId);
      if (!autoplay) await this.player?.pause().catch(() => undefined);
    } catch (e) {
      clientLog('error', `spotify sdk: load failed — ${(e as Error).message}`);
      if (seq === this.seq) this.errorFn((e as Error).message);
    }
  }

  /** Start one track on this tab's device via the Web API (the SDK has no "play this" call). */
  /** Turn off Spotify's own shuffle / repeat on this device: rune already sends songs in play order. */
  private async ensurePlainOrder(deviceId: string) {
    // What this device last reported. Nothing reported yet: try both, but once.
    const known = this.report;
    const shuffle = known ? known.shuffle : true;
    const repeat = known ? known.repeat !== 0 : true;
    if (!shuffle && !repeat) return; // already plain: no request
    if (!known && this.modesChecked) return;
    this.modesChecked = true;
    try {
      const token = await spotifyToken();
      const h = { Authorization: `Bearer ${token}` };
      const dev = `device_id=${encodeURIComponent(deviceId)}`;
      // Only the mode that is actually on: Spotify's request budget is tight.
      if (shuffle) {
        const res = await fetch(`https://api.spotify.com/v1/me/player/shuffle?state=false&${dev}`, { method: 'PUT', headers: h });
        // Out of quota: do not send the second write (or retry).
        if (res.status === 429) return;
      }
      if (repeat) await fetch(`https://api.spotify.com/v1/me/player/repeat?state=off&${dev}`, { method: 'PUT', headers: h });
    } catch { /* best effort: rune still corrects the song at each change */ }
  }

  private async playOnDevice(deviceId: string, uris: string[], startMs: number, stale: () => boolean) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (stale()) return;
      const token = await spotifyToken(attempt > 0 && this.lastStatus === 401);
      const res = await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ uris, offset: { position: 0 }, position_ms: Math.max(0, Math.round(startMs)) }),
      });
      this.lastStatus = res.status;
      clientLog(res.ok ? 'info' : 'warn', `spotify sdk: PUT /me/player/play → ${res.status}`, { attempt, deviceId, volume: this.volume });
      if (res.ok) return;
      if (res.status === 404) { // device not known to Spotify yet: transfer playback to it, then retry
        await fetch('https://api.spotify.com/v1/me/player', {
          method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ device_ids: [deviceId], play: false }),
        }).catch(() => undefined);
        await sleep(600 * (attempt + 1));
        continue;
      }
      if (res.status === 401) continue;
      // Never retry a 429: Spotify's daily quota does not recover in seconds, and every
      // retry spends more of it.
      if (res.status === 429) {
        throw new Error(
          'Spotify is refusing requests right now (daily limit reached) — try again later. Local music still works.',
        );
      }
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
    this.loadAt = 0; // a deliberate jump: positions far from the load point are real now
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
    if (this.reportPoll) clearInterval(this.reportPoll);
    this.reportActive = false;
    this.player?.disconnect();
  }
}
