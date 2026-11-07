// A simulated Spotify account for the audit tests: the Web API as rune's own comments record it, and (optionally)
// the desktop app's MPRIS view of it, as the phase 0 session recorded it. No network, no D-Bus.
import type { SpotifyDevice, SpotifyPlaybackState, SpotifyPlayBody, SpotifyQueue, SpotifyTrack } from '../../src/spotify/api.js';
import type { SpotifyZoneApi } from '../../src/spotify/zones.js';
import type { MprisBus, MprisEvent, MprisProps } from '../../src/spotify/mpris.js';
import type { StreamSample } from '../../src/play/playbackLog.js';

export const DEV = 'horse';
const DROP_MS = 600_000;
/** OpenUri → the app's PropertiesChanged took ~0.5 s in the phase 0 session. */
const SIGNAL_LAG_MS = 400;

export const sp = (id: string, dur: number): SpotifyTrack =>
  ({ id, name: id, uri: `spotify:track:${id}`, duration_ms: dur, disc_number: 1, track_number: 1, artists: [{ id: 'a', name: 'A' }], album: { id: 'alb', name: 'Alb', artists: [], images: [] } }) as unknown as SpotifyTrack;

/** What the World tells the fake app: one PropertiesChanged-like event. */
type Emit = (ev: MprisEvent) => void;

/** The desktop app's MPRIS, fed by the World. It only answers reads: nothing here controls anything. */
export class FakeMprisBus implements MprisBus {
  private fns = new Set<(ev: MprisEvent) => void>();
  reads = 0;
  closed = false;
  constructor(private readonly world: World) {}
  async read(): Promise<MprisProps | null> {
    this.reads++;
    return this.world.mprisProps();
  }
  async streams(): Promise<StreamSample[] | null> {
    return this.world.streams();
  }
  onEvent(fn: (ev: MprisEvent) => void): void {
    this.fns.add(fn);
  }
  emit(ev: MprisEvent): void {
    for (const f of this.fns) f(ev);
  }
  close(): void {
    this.closed = true;
  }
}

export class World implements SpotifyZoneApi {
  songs = new Map<string, SpotifyTrack>();
  cur: SpotifyTrack | null = null;
  device: string | null = null;
  playing = false; basePos = 0; baseAt = 0; pausedAt: number | null = null;
  volume = 100; log: string[] = []; polls: number[] = []; t0 = Date.now();
  /** Every Web API request, by kind (GET /me/player, GET queue, PUT play, …). */
  requests = new Map<string, number>();
  /** Next N reads of /me/player answer 204, as Spotify does before a dormant device is active. */
  nullReads = 0;
  /** Context playback (an album started in the app, or autoplay): at a song's end the next one starts. */
  context: string[] | null = null;
  /** The desktop app's MPRIS view (null = no MPRIS in this test). */
  mpris: FakeMprisBus | null = null;
  appOpen = true;
  /** What the app shows while another device plays: its own paused song (default) or a mirror of the phone. */
  mirrorsOtherDevice = false;
  /** The song the desktop app last had, and where: it keeps showing it paused after Spotify drops the Connect player. */
  appCur: SpotifyTrack | null = null;
  appPos = 0;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: { mpris?: boolean } = {}) {
    if (opts.mpris) this.mpris = new FakeMprisBus(this);
  }
  at() { return ((Date.now() - this.t0) / 1000).toFixed(1).padStart(7); }
  note(s: string) { this.log.push(`${this.at()}s ${s}`); }
  count(kind: string) { this.requests.set(kind, (this.requests.get(kind) ?? 0) + 1); }
  total() { let n = 0; for (const v of this.requests.values()) n += v; return n; }

  /** The app's signal for a change on this PC's device, a moment later. */
  private signal(ev: MprisEvent) {
    if (!this.mpris || !this.appOpen) return;
    const bus = this.mpris;
    setTimeout(() => bus.emit(ev), SIGNAL_LAG_MS);
  }
  private onHorse() { return this.device === DEV || (this.mirrorsOtherDevice && this.device !== null); }
  /** With MPRIS on, the World also runs on its own clock: a song ending is signalled when it ends. */
  private arm() {
    if (!this.mpris) return;
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
    if (!this.playing || !this.cur) return;
    const end = this.baseAt + (this.cur.duration_ms - this.basePos);
    this.endTimer = setTimeout(() => { this.endTimer = null; this.settle(); }, Math.max(0, end - Date.now()) + 1);
  }
  /** The app's own copy of what it plays: kept when the Connect player is dropped or moves away. */
  private remember() {
    if (this.device === DEV && this.cur) { this.appCur = this.cur; this.appPos = this.pos(); }
  }
  settle() {
    if (this.playing && this.cur) {
      const end = this.baseAt + (this.cur.duration_ms - this.basePos);
      if (Date.now() >= end) {
        const next = this.context ? this.context[this.context.indexOf(this.cur.id!) + 1] : undefined;
        if (next) {
          this.cur = this.songs.get(next)!; this.basePos = Date.now() - end; this.baseAt = Date.now();
          this.note(`[spotify] next in context: ${next}`);
          if (this.onHorse()) this.signal({ ev: 'signal', trackId: `sp:${next}`, lengthMs: this.cur.duration_ms });
          this.arm();
        } else {
          this.playing = false; this.basePos = 0; this.pausedAt = end; this.note(`[spotify] ${this.cur.id} finished: paused, rewound`);
          if (this.onHorse()) this.signal({ ev: 'signal', status: 'Paused' });
        }
      }
    }
    this.remember();
    if (!this.playing && this.pausedAt !== null && Date.now() - this.pausedAt > DROP_MS) { this.note('[spotify] player dropped'); this.cur = null; this.device = null; this.pausedAt = null; }
  }
  pos() { return this.playing ? this.basePos + Date.now() - this.baseAt : this.basePos; }
  externalPause() {
    this.settle(); const p = this.pos(); this.playing = false; this.basePos = p; this.pausedAt = Date.now(); this.note(`[user] paused in the Spotify app at ${(p / 1000).toFixed(0)}s`);
    if (this.onHorse()) this.signal({ ev: 'signal', status: 'Paused' });
    this.arm();
  }
  /** The user presses play in the desktop app: playback is on this PC again. */
  externalResume() {
    this.settle();
    if (!this.cur) { this.cur = this.appCur; this.basePos = this.appPos; }
    this.device = DEV; this.baseAt = Date.now(); this.playing = true; this.pausedAt = null;
    this.note(`[user] resumed in the Spotify app at ${(this.basePos / 1000).toFixed(0)}s`);
    this.signal({ ev: 'signal', status: 'Playing' });
    this.arm();
  }
  externalSeek(ms: number) {
    this.settle(); this.basePos = ms; this.baseAt = Date.now(); this.note(`[user] seeked in the Spotify app to ${(ms / 1000).toFixed(0)}s`);
    if (this.onHorse()) this.signal({ ev: 'seeked', positionMs: ms });
    this.arm();
  }
  otherDevice(id: string) {
    this.settle(); this.remember(); this.basePos = this.pos(); this.baseAt = Date.now(); this.device = id; this.note(`[user] moved playback to ${id}`);
    // The app stops sounding; whether it shows the phone's song is what mirrorsOtherDevice says.
    if (this.mirrorsOtherDevice) this.signal({ ev: 'signal', status: this.playing ? 'Playing' : 'Paused' });
    else this.signal({ ev: 'signal', status: 'Paused' });
    this.arm();
  }
  closeApp() {
    this.appOpen = false; this.note('[user] closed the Spotify app');
    if (this.device === DEV) { this.settle(); this.basePos = this.pos(); this.playing = false; this.device = null; this.cur = null; }
    this.mpris?.emit({ ev: 'owner', owned: false });
    this.arm();
  }

  // ----- MPRIS view -----
  /** What the app's MPRIS says now; null when the app is closed. */
  mprisProps(): MprisProps | null {
    if (!this.appOpen) return null;
    this.settle();
    const here = this.onHorse();
    const song = here ? this.cur : this.appCur;
    if (!song) return { status: 'Stopped', trackId: null, lengthMs: 0, positionMs: 0, volume: 1, shuffle: false, loop: 'None', title: null, artists: [], album: null, artUrl: null };
    // MPRIS reports the length a little short of the catalogue's (89000 vs 89373 ms in phase 0).
    const lengthMs = Math.floor(song.duration_ms / 1000) * 1000;
    return {
      status: here && this.playing ? 'Playing' : 'Paused',
      trackId: `sp:${song.id}`,
      lengthMs,
      positionMs: Math.round(here ? this.pos() : this.appPos),
      volume: this.volume / 100,
      shuffle: false,
      loop: 'None',
      title: song.name,
      artists: ['A'],
      album: 'Alb',
      artUrl: null,
    };
  }
  /** The app's PipeWire stream: open while it has a song, uncorked only while it sounds on this PC. */
  streams(): StreamSample[] {
    if (!this.appOpen || !this.cur) return [];
    return [{ sink: 'speakers', muted: false, volume: 100, corked: !(this.device === DEV && this.playing), sinkMuted: false, sinkVolume: 40 }];
  }

  // ----- Web API -----
  async devices(): Promise<SpotifyDevice[]> { this.count('GET devices'); return []; }
  async tracks(ids: string[]) { this.count('GET tracks'); return ids.map((i) => this.songs.get(i)!).filter(Boolean); }
  async track(id: string) { this.count('GET track'); return this.songs.get(id)!; }
  async currentPlayback(): Promise<SpotifyPlaybackState | null> {
    this.count('GET /me/player');
    this.polls.push(Date.now() - this.t0);
    this.settle();
    if (this.nullReads > 0) { this.nullReads--; this.note('[spotify] GET /me/player -> 204'); return undefined as unknown as null; }
    if (!this.cur || !this.device) return null;
    return { device: { id: this.device, is_active: true, is_private_session: false, is_restricted: false, name: 'x', type: 'Computer', volume_percent: this.volume }, repeat_state: 'off', shuffle_state: false, timestamp: Date.now(), progress_ms: Math.round(this.pos()), is_playing: this.playing, item: this.cur } as SpotifyPlaybackState;
  }
  async queue(): Promise<SpotifyQueue> { this.count('GET queue'); return { currently_playing: null, queue: [] }; }
  async play(body: SpotifyPlayBody, device?: string) {
    this.count('PUT play');
    this.settle();
    const was = this.cur?.id;
    const wasPlaying = this.playing && this.device === DEV;
    if (body.uris?.length) { const id = body.uris[body.offset?.position ?? 0]!.split(':').pop()!; this.cur = this.songs.get(id)!; this.basePos = body.position_ms ?? 0; this.context = null; this.note(`[rune] PUT play ${id} on ${device}`); }
    else { this.note('[rune] PUT play (resume)'); }
    this.device = device ?? this.device; this.baseAt = Date.now(); this.playing = true; this.pausedAt = null;
    this.remember();
    if (this.device === DEV) {
      // A start from paused: status + track together; a change while playing: the track id only (phase 0).
      if (!wasPlaying) this.signal({ ev: 'signal', status: 'Playing', trackId: `sp:${this.cur!.id}`, lengthMs: this.cur!.duration_ms });
      else if (was !== this.cur?.id) this.signal({ ev: 'signal', trackId: `sp:${this.cur!.id}`, lengthMs: this.cur!.duration_ms });
      else this.signal({ ev: 'seeked', positionMs: this.basePos });
    }
    this.arm();
  }
  async pause() {
    this.count('PUT pause');
    this.settle(); this.basePos = this.pos(); this.playing = false; this.pausedAt = Date.now(); this.note('[rune] PUT pause');
    if (this.device === DEV) this.signal({ ev: 'signal', status: 'Paused' });
    this.arm();
  }
  async next() { this.count('POST next'); } async previous() { this.count('POST previous'); }
  async seek(ms: number) {
    this.count('PUT seek');
    this.settle(); this.basePos = ms; this.baseAt = Date.now(); this.note(`[rune] PUT seek ${ms}`);
    if (this.device === DEV) this.signal({ ev: 'seeked', positionMs: ms });
    this.arm();
  }
  async setShuffle() { this.count('PUT shuffle'); } async setRepeat() { this.count('PUT repeat'); } async enqueue() { this.count('POST queue'); }
  async setVolume(v: number) {
    this.count('PUT volume');
    this.volume = v; this.note(`[rune] PUT volume ${v}`);
    if (this.device === DEV) this.signal({ ev: 'signal', volume: v / 100 });
  }
  dispose() { if (this.endTimer) clearTimeout(this.endTimer); this.endTimer = null; }
}
