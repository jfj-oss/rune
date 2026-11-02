import type { PlayerState, QueueItem, Zone } from '@liner/shared';
import { create } from 'zustand';
import { api, isMock } from '../api';
import type { ExtCommand, PlayItem, ZoneInfo } from '../lib/types';
import { AudioEngine, MockEngine } from '../player/engine';
import { LocalBackend } from '../player/local';
import { RemoteBackend } from '../player/remote';
import { emptyState, livePosition, type Backend } from '../player/types';
import { loadLocal, saveLocal, useUi } from './ui';

const backends = new Map<Zone, Backend>();
let unsub: (() => void) | null = null;

function deviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'This iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) return 'This iPad';
  if (/Macintosh/.test(ua)) return 'This Mac';
  if (/Android/.test(ua)) return 'This phone';
  return 'This computer';
}
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
  setZone(id: Zone): Promise<void>;
  playItems(items: PlayItem[], startIndex?: number, opts?: { shuffle?: boolean }): Promise<void>;
  enqueueItems(items: PlayItem[], next?: boolean): Promise<void>;
  command(cmd: ExtCommand): Promise<void>;
}

function backendFor(z: ZoneInfo): Backend {
  const hit = backends.get(z.id);
  if (hit) return hit;
  const notice = (m: string) => useUi.getState().toast(m);
  let b: Backend;
  if (isMock) b = new LocalBackend(z.id, new MockEngine(), undefined, notice);
  else if (z.kind === 'browser') b = new LocalBackend(z.id, new AudioEngine(), undefined, notice);
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

export const usePlayer = create<PlayerStore>((set, get) => {
  const rec = { albumId: null as string | null };
  const attach = (b: Backend) => {
    unsub?.();
    unsub = b.subscribe((s) => { set({ state: s }); recordPlayed(s, rec); });
    set({ state: b.state, zone: b.zone });
  };
  return {
    zones: FALLBACK_ZONES,
    zone: 'pc',
    state: emptyState('pc'),
    ready: false,

    async init() {
      if (get().ready) return;
      let zones = FALLBACK_ZONES;
      try { zones = await api.zones(); } catch { /* server offline: keep fallback */ }
      if (!zones.length) zones = FALLBACK_ZONES;
      // The browser zone lives in this tab, so the server never lists it.
      if (!isMock && !zones.some((z) => z.kind === 'browser')) zones = [...zones, BROWSER_ZONE];
      const mobile = typeof window !== 'undefined' && window.matchMedia('(max-width: 899px)').matches;
      const saved = loadLocal<string | null>('rune.zone', null);
      const pick = zones.find((z) => z.id === saved) ?? zones.find((z) => z.kind === (mobile ? 'browser' : 'pc')) ?? zones[0]!;
      set({ zones });
      const b = backendFor(pick);
      if (isMock) await seedMock(b);
      attach(b);
      set({ ready: true });
    },

    async setZone(id) {
      const z = get().zones.find((x) => x.id === id);
      if (!z || id === get().zone) return;
      saveLocal('rune.zone', id);
      const prev = backends.get(get().zone);
      const b = backendFor(z);
      // Hand playback over (like Roon's "transfer zone"): same queue, same track, same
      // position, same play/pause state — then stop the old zone.
      if (prev && prev !== b) {
        try {
          await prev.refresh();
        } catch {
          /* old zone unreachable: transfer from the last state we saw */
        }
        const s = prev.state;
        const active = (s.status === 'playing' || s.status === 'paused' || s.status === 'loading') && s.index >= 0 && s.queue.length > 0;
        if (active) {
          const items: PlayItem[] = s.queue.map((q) => ({ track: q.track, album: q.album }));
          const toSpotify = z.kind === 'spotify';
          const playable = items.filter((i) => (i.track.source === 'spotify') === toSpotify);
          const current = items[s.index]!;
          const notice = (m: string) => useUi.getState().toast(m);
          if ((current.track.source === 'spotify') !== toSpotify) {
            notice(toSpotify ? 'Spotify devices can only play Spotify tracks — your local files stay where they are' : 'Spotify tracks play on a Spotify device');
          } else {
            const startIndex = playable.indexOf(current);
            const positionMs = livePosition(s);
            const paused = s.status === 'paused';
            if (s.status === 'playing') await prev.send({ type: 'pause' }).catch(() => undefined);
            attach(b);
            await b.send({ type: 'play', trackIds: playable.map((i) => i.track.id), startIndex, positionMs, paused }, playable);
            if (s.repeat !== 'off') await b.send({ type: 'repeat', mode: s.repeat }).catch(() => undefined);
            if (playable.length < items.length) notice(`Moved ${playable.length} of ${items.length} queued tracks (the rest can't play on ${z.name})`);
            return;
          }
        }
      }
      attach(b);
      await b.refresh();
    },

    async playItems(items, startIndex = 0, opts) {
      const b = backends.get(get().zone);
      if (!b || !items.length) return;
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
      await b.send({ type: 'play', trackIds: list.map((i) => i.track.id), startIndex: start }, list);
      if (opts?.shuffle) await b.send({ type: 'shuffle', on: true });
    },

    async enqueueItems(items, next) {
      const b = backends.get(get().zone);
      if (!b || !items.length) return;
      await b.send({ type: 'enqueue', trackIds: items.map((i) => i.track.id), next }, items);
      useUi.getState().toast(next ? 'Playing next' : `Added to queue — ${items.length} ${items.length === 1 ? 'track' : 'tracks'}`);
    },

    async command(cmd) {
      const b = backends.get(get().zone);
      if (!b) return;
      try { await b.send(cmd); } catch { useUi.getState().toast('That did not work — is the server reachable?'); }
    },
  };
});

export const currentItem = (s: PlayerState): QueueItem | undefined => s.queue[s.index];

/** Signal path to show for the active zone (mock mode derives one for the PC zone). */
export function useSignalPath(): { steps: string[]; tone: 'ok' | 'warn' | 'off' } {
  const state = usePlayer((s) => s.state);
  const zones = usePlayer((s) => s.zones);
  const kind = zones.find((z) => z.id === state.zone)?.kind ?? 'pc';
  const cur = state.queue[state.index]?.track;
  if (kind === 'spotify' || cur?.source === 'spotify') {
    return { steps: ['Spotify', 'Spotify Connect', zones.find((z) => z.id === state.zone)?.name ?? 'Device'], tone: 'off' };
  }
  let steps = state.signalPath;
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
