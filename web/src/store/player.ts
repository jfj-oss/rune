import type { PlayerState, QueueItem, Zone } from '@liner/shared';
import { create } from 'zustand';
import { ApiError, api, isMock } from '../api';
import { deviceName } from '../lib/device';
import { isLiveTrack } from '../lib/listenTypes';
import type { ExtCommand, PlayItem, ZoneInfo } from '../lib/types';
import { AudioEngine, MockEngine } from '../player/engine';
import { HybridEngine } from '../player/hybrid';
import { LocalBackend } from '../player/local';
import { PcBackend, type PcDevice } from '../player/pc';
import { needsPcSpotify, startPcSpotifyAndWait } from '../player/pcStart';
import { fitForZone } from '../player/preferLocal';
import { RemoteBackend, socket, zoneTransport } from '../player/remote';
import { cantPlayMessage, followPcSpeakers, noteSounding, playableZones, routeItems, withoutOwnDevice, withoutPcDevice, zoneCanPlay } from '../player/routing';
import { emptyState, livePosition, type Backend } from '../player/types';
import { capsFrom, getSdkEngine, sdkName, useSpotify, type ChooserRequest } from './spotify';
import { loadLocal, saveLocal, useUi } from './ui';

const backends = new Map<Zone, Backend>();
let unsub: (() => void) | null = null;

const BROWSER_ZONE: ZoneInfo = { id: 'browser', name: deviceName(), kind: 'browser' };

const FALLBACK_ZONES: ZoneInfo[] = [
  { id: 'pc', name: 'Linux PC speakers', kind: 'pc' },
  BROWSER_ZONE,
];

interface PlayerStore {
  zones: ZoneInfo[];
  zone: Zone;
  state: PlayerState;
  ready: boolean;
  init(): Promise<void>;
  /** handoff:false = just switch (nothing is carried over from the old zone). */
  setZone(id: Zone, opts?: { handoff?: boolean }): Promise<void>;
  /** Re-read the zone list (Spotify Connect devices come and go). */
  refreshZones(): Promise<void>;
  playItems(items: PlayItem[], startIndex?: number, opts?: { shuffle?: boolean; context?: string }): Promise<void>;
  /** Answer of the "Play on…" sheet. */
  playOn(zone: Zone, req: ChooserRequest, remember?: boolean): Promise<void>;
  /** quiet: no "Added to queue" toast (auto-radio continues on its own). */
  enqueueItems(items: PlayItem[], next?: boolean, opts?: { quiet?: boolean }): Promise<void>;
  command(cmd: ExtCommand): Promise<void>;
}

const pcDevice = (z: ZoneInfo): PcDevice | null => (z.spotifyDeviceId ? { id: z.spotifyDeviceId, name: z.spotifyDeviceName ?? 'Spotify' } : null);

/** The Spotify app on the PC can start or quit at any time: keep the pc backend in step with the zone list. */
function syncPcDevice(zones: ZoneInfo[]) {
  const z = zones.find((x) => x.kind === 'pc');
  const b = z && backends.get(z.id);
  if (z && b instanceof PcBackend) b.setDevice(pcDevice(z));
}

/** Server zone list -> what the UI lists (the PC's own Spotify app is folded into the pc zone). */
function tidyZones(zones: ZoneInfo[]): ZoneInfo[] {
  let out = zones;
  if (!isMock && !out.some((z) => z.kind === 'browser')) out = [...out, BROWSER_ZONE]; // the browser zone lives in this tab
  if (!isMock) out = withoutOwnDevice(out, { name: sdkName(), deviceId: useSpotify.getState().sdk.deviceId });
  return withoutPcDevice(out);
}

function backendFor(z: ZoneInfo): Backend {
  const hit = backends.get(z.id);
  if (hit) return hit;
  const notice = (m: string) => useUi.getState().toast(m);
  // Browser/mock queues end in this tab: let auto-radio pick up (dynamic import avoids
  // a cycle: lib/radio uses usePlayer for the current state).
  const onQueueEnd = () => { void import('../lib/radio').then((m) => m.continueRadio()).catch(() => undefined); };
  let b: Backend;
  if (isMock) b = new LocalBackend(z.id, new HybridEngine(new MockEngine(), new MockEngine()), undefined, notice, onQueueEnd);
  else if (z.kind === 'browser') b = new LocalBackend(z.id, new HybridEngine(new AudioEngine(), getSdkEngine()), undefined, notice, onQueueEnd);
  else if (z.kind === 'pc') b = new PcBackend({ remote: (id) => new RemoteBackend(id), transport: zoneTransport, notice }, pcDevice(z));
  else b = new RemoteBackend(z.id);
  backends.set(z.id, b);
  return b;
}

async function seedMock(b: Backend) {
  const { ALBUMS, FULL_ALBUM_ID } = await import('../mock/data');
  const al = ALBUMS.find((a) => a.id === FULL_ALBUM_ID);
  if (!al || !(b instanceof LocalBackend)) return;
  const items: PlayItem[] = al.tracks.map((track) => ({ track, album: { id: al.id, title: al.title, coverUrl: al.coverUrl } }));
  await b.send({ type: 'play', trackIds: [], startIndex: 2 }, items);
  await b.send({ type: 'seek', positionMs: 74_000 });
  await b.send({ type: 'volume', volume: 62 });
  if (loadLocal<unknown[]>('rune.played', []).length === 0) {
    const day = 86_400_000;
    saveLocal('rune.played', [1, 3, 6, 14, 19, 21, 25].map((i, n) => ({ id: (ALBUMS[i] ?? al).id, at: Date.now() - (n + 1) * 3 * day })));
  }
}

function recordPlayed(state: PlayerState, prev: { albumId: string | null }) {
  const cur = state.queue[state.index];
  if (!cur || state.status !== 'playing' || cur.album.id === prev.albumId) return;
  prev.albumId = cur.album.id;
  const list = loadLocal<{ id: string; at: number }[]>('rune.played', []).filter((p) => p.id !== cur.album.id);
  list.unshift({ id: cur.album.id, at: Date.now() });
  saveLocal('rune.played', list.slice(0, 60));
}

/** Spotify's play call takes at most 100 URIs, so a Connect device gets a window of the list. */
const CONNECT_WINDOW = 100;

async function startOn(b: Backend, z: ZoneInfo, items: PlayItem[], startIndex: number, shuffled?: boolean) {
  let list = items;
  let start = startIndex;
  if (z.kind === 'spotify' && list.length > CONNECT_WINDOW) { list = list.slice(start, start + CONNECT_WINDOW); start = 0; }
  await b.send({ type: 'play', trackIds: list.map((i) => i.track.id), startIndex: start }, list);
  if (shuffled) await b.send({ type: 'shuffle', on: true });
}

/** The current zone can't play this: use the remembered choice, or ask ("Play on…" sheet). */
function routeElsewhere(req: ChooserRequest): Promise<void> | void {
  const { zones } = usePlayer.getState();
  const sp = useSpotify.getState();
  const options = playableZones(zones, req.need, capsFrom(sp));
  const remembered = options.find((o) => o.zone.id === sp.choices[req.need]);
  if (remembered) {
    useUi.getState().toast(`Playing on ${remembered.label}`);
    return usePlayer.getState().playOn(remembered.zone.id, req, false);
  }
  void usePlayer.getState().refreshZones();
  sp.askWhere(req);
}

/** The server's own explanation (`{ error }`) when it sent one; generic text for a dead network. */
function reportCommandFailure(e: unknown): void {
  const message =
    e instanceof ApiError && e.serverMessage ? e.serverMessage : 'That did not work — is the server reachable?';
  useUi.getState().toast(message);
}

export const usePlayer = create<PlayerStore>((set, get) => {
  const rec = { albumId: null as string | null };
  const attach = (b: Backend) => {
    unsub?.();
    unsub = b.subscribe((s) => { set({ state: s }); recordPlayed(s, rec); });
    set({ state: b.state, zone: b.zone });
  };

  /**
   * Spotify tracks are headed for the pc zone but the PC's Spotify app is closed:
   * ask the server to start it and wait for its Connect device. Returns the refreshed
   * pc zone (so the caller can carry on as if it had been there), or null when the
   * app never appeared — in which case no playback has been touched.
   */
  /** Spotify tracks the user also owns play from the local file, on zones that can play local files. */
  /** Each song in the copy this zone can play (own file or Spotify), so as little as possible is skipped. */
  function ownCopies(z: ZoneInfo, items: PlayItem[], startIndex = 0, whole = true): Promise<PlayItem[]> {
    const sp = useSpotify.getState();
    const caps = capsFrom(sp);
    const can = { local: zoneCanPlay(z, 'local', caps), spotify: zoneCanPlay(z, 'spotify', caps), spotifyElsewhere: sp.connected };
    return fitForZone(items, startIndex, can, { toLocal: api.localTwins, toSpotify: api.spotifyTwins }, whole);
  }

  async function ensurePcSpotify(items: PlayItem[], z: ZoneInfo): Promise<ZoneInfo | null> {
    if (isMock || !needsPcSpotify(z, items)) return z; // mock playback runs in this tab
    return startPcSpotifyAndWait({
      start: () => api.pcSpotifyStart(),
      readZones: async () => {
        const zones = tidyZones(await api.zones());
        // never drop the zone we are playing on
        const cur = get().zones.find((x) => x.id === get().zone);
        const merged = cur && !zones.some((x) => x.id === cur.id) ? [...zones, cur] : zones;
        set({ zones: merged });
        syncPcDevice(merged);
        return merged;
      },
      toast: (m) => useUi.getState().toast(m),
    });
  }

  return {
    zones: FALLBACK_ZONES,
    zone: 'pc',
    state: emptyState('pc'),
    ready: false,

    async init() {
      if (get().ready) return;
      if (!isMock) {
        const playing = new Map<string, boolean>();
        socket.on((e) => {
          if (e.type !== 'player') return;
          const was = noteSounding(playing, e.state);
          const { zone, state, zones, setZone } = get();
          if (followPcSpeakers(e.state, was, { zone, status: state.status }, zones.find((z) => z.kind === 'pc'))) void setZone('pc', { handoff: false });
        });
      }
      const [zonesRes] = await Promise.all([api.zones().catch(() => FALLBACK_ZONES), useSpotify.getState().init().catch(() => undefined)]);
      const zones = tidyZones(zonesRes.length ? zonesRes : FALLBACK_ZONES);
      const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches;
      const saved = loadLocal<string | null>('rune.zone', null);
      const pick = zones.find((z) => z.id === saved) ?? zones.find((z) => z.kind === (mobile ? 'browser' : 'pc')) ?? zones[0]!;
      set({ zones });
      const b = backendFor(pick);
      if (isMock) await seedMock(b);
      attach(b);
      set({ ready: true });
    },

    async refreshZones() {
      if (isMock) return;
      try {
        let zones = tidyZones(await api.zones());
        // never drop the zone we are playing on
        const cur = get().zones.find((z) => z.id === get().zone);
        if (cur && !zones.some((z) => z.id === cur.id)) zones = [...zones, cur];
        set({ zones });
        syncPcDevice(zones);
      } catch { /* keep what we have */ }
    },

    async setZone(id, opts) {
      try {
      let z = get().zones.find((x) => x.id === id);
      if (!z || id === get().zone) return;
      const handoff = opts?.handoff !== false;
      if (handoff) { useSpotify.getState().remember('spotify', undefined); useSpotify.getState().remember('local', undefined); }
      saveLocal('rune.zone', id);
      const prev = backends.get(get().zone);
      if (!handoff) {
        const b = backendFor(z);
        if (prev && prev !== b && (prev.state.status === 'playing' || prev.state.status === 'loading')) await prev.send({ type: 'pause' }).catch(() => undefined);
        attach(b);
        await b.refresh();
        return;
      }
      // Hand playback over (like Roon's "transfer zone"): same queue, same track, same
      // position, same play/pause state — then stop the old zone.
      if (prev) {
        try {
          await prev.refresh();
        } catch {
          /* old zone unreachable: transfer from the last state we saw */
        }
        const s = prev.state;
        const active = (s.status === 'playing' || s.status === 'paused' || s.status === 'loading') && s.index >= 0 && s.queue.length > 0;
        if (active) {
          const items: PlayItem[] = s.queue.map((q) => ({ track: q.track, album: q.album }));
          // Spotify + Linux PC speakers: rune starts the desktop app first, then this
          // handoff proceeds exactly as if its Connect device had been there already.
          if (needsPcSpotify(z, items)) {
            const pc = await ensurePcSpotify(items, z);
            if (!pc) return; // timed out: the music stays where it is
            z = pc;
          }
          const target = z;
          const b = backendFor(target);
          if (prev !== b) {
            const caps = capsFrom(useSpotify.getState());
            const playable = items.filter((i) => zoneCanPlay(target, i.track.source, caps));
            const current = items[s.index]!;
            const notice = (m: string) => useUi.getState().toast(m);
            if (!zoneCanPlay(target, current.track.source, caps)) {
              notice(`${cantPlayMessage(target, current.track.source)} — the music stays where it is`);
            } else {
              const startIndex = playable.indexOf(current);
              const positionMs = livePosition(s);
              const paused = s.status === 'paused';
              if (s.status === 'playing' || s.status === 'loading') await prev.send({ type: 'pause' }).catch(() => undefined);
              attach(b);
              await b.send({ type: 'play', trackIds: playable.map((i) => i.track.id), startIndex, positionMs, paused }, playable);
              if (s.repeat !== 'off') await b.send({ type: 'repeat', mode: s.repeat }).catch(() => undefined);
              // keep the loudness: the target may sit at its own, much lower level (the PC's Spotify app was at 10% = silent)
              if (s.volume > 0 && Math.abs(b.state.volume - s.volume) > 1) await b.send({ type: 'volume', volume: s.volume }).catch(() => undefined);
              if (playable.length < items.length) notice(`Moved ${playable.length} of ${items.length} queued tracks (the rest can't play on ${target.name})`);
              else if (target.kind === 'pc' && playable.some((i) => i.track.source === 'spotify') && playable.some((i) => i.track.source === 'local')) notice('Mixed queue on the PC — keep a rune tab open so it can switch between local and Spotify tracks');
              return;
            }
          }
        }
      }
      const b = backendFor(z);
      attach(b);
      await b.refresh();
      } catch (e) {
        reportCommandFailure(e);
      }
    },

    async playItems(items, startIndex = 0, opts) {
      try {
        if (!items.length) return;
        const st = get();
        let z = st.zones.find((x) => x.id === st.zone);
        if (!z || !backends.get(z.id)) return;
        let list = items;
        let start = startIndex;
        if (opts?.shuffle) {
          list = items.slice();
          for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j] as PlayItem, list[i] as PlayItem];
          }
          start = 0;
        }
        // Owned songs play from the local file (and then need no Spotify app at all).
        list = await ownCopies(z, list, start);
        // Sending Spotify tracks to the PC speakers: start the app and wait for it.
        if (needsPcSpotify(z, list)) {
          const pc = await ensurePcSpotify(list, z);
          if (!pc) return; // timed out: nothing was paused or moved
          z = pc;
        }
        const route = routeItems(z, list, start, capsFrom(useSpotify.getState()));
        if (!route.ok) {
          await routeElsewhere({ items: list, startIndex: start, shuffle: opts?.shuffle, need: route.need, context: opts?.context });
          return;
        }
        if (route.dropped) useUi.getState().toast(`${route.dropped} ${route.dropped === 1 ? 'track' : 'tracks'} skipped — ${z.name} can't play them`);
        await startOn(backends.get(z.id)!, z, route.items, route.startIndex, opts?.shuffle);
      } catch (e) {
        // e.g. a 429 from the Spotify quota: show the server's own explanation, never leave
        // this promise unhandled (callers fire it with `void`).
        reportCommandFailure(e);
      }
    },

    async playOn(zoneId, req, remember = true) {
      try {
        let z = get().zones.find((x) => x.id === zoneId);
        if (!z) return;
        req = { ...req, items: await ownCopies(z, req.items, req.startIndex) };
        // Chosen from the "Play on…" sheet: starting Spotify is still only a step of
        // actually sending Spotify tracks to the PC speakers.
        if (needsPcSpotify(z, req.items)) {
          const pc = await ensurePcSpotify(req.items, z);
          if (!pc) return; // timed out: the music stays where it is
          z = pc;
        }
        const caps = capsFrom(useSpotify.getState());
        const route = routeItems(z, req.items, req.startIndex, { sdk: caps.sdk });
        if (!route.ok) return;
        if (remember) useSpotify.getState().remember(req.need, zoneId);
        await get().setZone(zoneId, { handoff: false });
        const b = backends.get(zoneId);
        if (!b) return;
        if (route.dropped) useUi.getState().toast(`${route.dropped} ${route.dropped === 1 ? 'track' : 'tracks'} skipped — ${z.name} can't play them`);
        await startOn(b, z, route.items, route.startIndex, req.shuffle);
      } catch (e) {
        reportCommandFailure(e);
      }
    },

    async enqueueItems(items, next, opts) {
      try {
        const st = get();
        let z = st.zones.find((x) => x.id === st.zone);
        const b = z && backends.get(z.id);
        if (!z || !b || !items.length) return;
        items = await ownCopies(z, items, 0, false);
        // Queueing Spotify tracks on the PC speakers needs the app too.
        if (needsPcSpotify(z, items)) {
          const pc = await ensurePcSpotify(items, z);
          if (!pc) return; // timed out: the queue and playback stay where they are
          z = pc;
        }
        const caps = capsFrom(useSpotify.getState());
        const ok = items.filter((i) => zoneCanPlay(z, i.track.source, caps));
        if (!ok.length) {
          useUi.getState().toast(z.kind === 'pc' ? cantPlayMessage(z, items[0]!.track.source) : `${cantPlayMessage(z, items[0]!.track.source)} — pick another zone first`);
          return;
        }
        await b.send({ type: 'enqueue', trackIds: ok.map((i) => i.track.id), next }, ok);
        if (opts?.quiet) return;
        const skipped = items.length - ok.length;
        useUi.getState().toast(next ? 'Playing next' : `Added to queue — ${ok.length} ${ok.length === 1 ? 'track' : 'tracks'}${skipped ? ` (${skipped} can't play here)` : ''}`);
      } catch (e) {
        reportCommandFailure(e);
      }
    },

    async command(cmd) {
      const b = backends.get(get().zone);
      if (!b) return;
      try { await b.send(cmd); } catch (e) { reportCommandFailure(e); }
    },
  };
});

export const currentItem = (s: PlayerState): QueueItem | undefined => s.queue[s.index];

/** Signal path to show for the active zone (mock mode derives one for the PC zone). */
export function useSignalPath(): { steps: string[]; tone: 'ok' | 'warn' | 'off' } {
  const zone = usePlayer((s) => s.state.zone);
  const signalPath = usePlayer((s) => s.state.signalPath);
  const cur = usePlayer((s) => s.state.queue[s.state.index]?.track);
  const zones = usePlayer((s) => s.zones);
  const kind = zones.find((z) => z.id === zone)?.kind ?? 'pc';
  if (kind === 'spotify') {
    return { steps: ['Spotify', 'Spotify Connect', zones.find((z) => z.id === zone)?.name ?? 'Device'], tone: 'off' };
  }
  if (cur?.source === 'spotify') {
    return { steps: ['Spotify', 'Web Playback SDK', zones.find((z) => z.id === zone)?.name ?? 'This browser'], tone: 'off' };
  }
  if (isLiveTrack(cur)) {
    const fmt = [cur!.format && cur!.format !== 'other' ? cur!.format.toUpperCase() : 'Stream', cur!.bitrateKbps ? `${cur!.bitrateKbps} kbps` : ''].filter(Boolean).join(' ');
    const liveSteps = kind === 'pc'
      ? [fmt, 'mpv', 'PipeWire', 'live stream']
      : [fmt, 'Browser audio', 'live stream'];
    return { steps: liveSteps, tone: 'warn' };
  }
  let steps = signalPath;
  if (!steps && cur) {
    if (kind === 'pc') {
      const fmt = cur.format === 'mp3' ? `MP3 ${cur.bitrateKbps ?? 320}` : `FLAC ${cur.bitDepth ?? 16}/${(cur.sampleRate ?? 44100) / 1000}`;
      steps = cur.format === 'mp3' ? [fmt, 'mpv', 'PipeWire 48 kHz', 'resampled'] : [fmt, 'mpv', `PipeWire ${Math.round((cur.sampleRate ?? 44100) / 1000)} kHz`, 'bit-perfect'];
    } else steps = [cur.format === 'mp3' ? 'MP3' : 'FLAC', 'Transcoded to Opus', 'Browser audio'];
  }
  steps = steps ?? [];
  const bitPerfect = steps.some((s) => /bit-perfect/i.test(s));
  return { steps, tone: steps.length === 0 ? 'off' : bitPerfect ? 'ok' : 'warn' };
}
