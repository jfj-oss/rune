// API client for the four listen features — kept apart from api.ts so parallel work
// does not collide. Shapes mirror server/src/{radio,iradio,peaks,loudness}.ts.
import type { Track } from '@liner/shared';
import { http, isMock } from './api';
import type {
  NormalizeMode,
  PeaksResult,
  RadioFrom,
  RadioSearchParams,
  RadioSearchResult,
  RadioStartResult,
  RadioStation,
} from './lib/listenTypes';

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? '?' + s : '';
}

const mock = () => import('./mock/listen');

/** Peaks are immutable per (track, bucket count); keep them for the session. */
const peakCache = new Map<string, Promise<PeaksResult | null>>();

export const listenApi = {
  // ---------- rune radio ----------
  async radioStart(from: RadioFrom, id: string, count?: number): Promise<RadioStartResult> {
    if (isMock) return (await mock()).mockListen.radioStart(from, id, count);
    return http('/radio/start', { method: 'POST', body: JSON.stringify({ from, id, count }) });
  },
  async radioNext(trackIds: string[], recentTrackIds: string[], count?: number): Promise<RadioStartResult> {
    if (isMock) return (await mock()).mockListen.radioNext(trackIds, recentTrackIds, count);
    return http('/radio/next', { method: 'POST', body: JSON.stringify({ trackIds, recentTrackIds, count }) });
  },
  async autoRadio(): Promise<boolean> {
    if (isMock) return (await mock()).mockListen.autoRadio();
    return (await http<{ enabled: boolean }>('/settings/autoRadio')).enabled;
  },
  async setAutoRadio(enabled: boolean): Promise<boolean> {
    if (isMock) return (await mock()).mockListen.setAutoRadio(enabled);
    return (await http<{ enabled: boolean }>('/settings/autoRadio', { method: 'POST', body: JSON.stringify({ enabled }) })).enabled;
  },

  // ---------- volume levelling ----------
  async normalize(): Promise<NormalizeMode> {
    if (isMock) return (await mock()).mockListen.normalize();
    return (await http<{ mode: NormalizeMode }>('/settings/normalize')).mode;
  },
  async setNormalize(mode: NormalizeMode): Promise<NormalizeMode> {
    if (isMock) return (await mock()).mockListen.setNormalize(mode);
    return (await http<{ mode: NormalizeMode }>('/settings/normalize', { method: 'POST', body: JSON.stringify({ mode }) })).mode;
  },

  // ---------- internet radio ----------
  async stations(params: RadioSearchParams = {}): Promise<RadioSearchResult> {
    if (isMock) return (await mock()).mockListen.stations(params);
    return http(`/radio/stations${qs({ ...params })}`);
  },
  async favourites(): Promise<RadioStation[]> {
    if (isMock) return (await mock()).mockListen.favourites();
    return http('/radio/favourites');
  },
  async addFavourite(id: string): Promise<RadioStation | undefined> {
    if (isMock) return (await mock()).mockListen.addFavourite(id);
    return http('/radio/favourites', { method: 'POST', body: JSON.stringify({ id }) });
  },
  async removeFavourite(id: string): Promise<void> {
    if (isMock) return (await mock()).mockListen.removeFavourite(id);
    await http(`/radio/favourites${qs({ id })}`, { method: 'DELETE' });
  },
  async station(id: string): Promise<RadioStation | undefined> {
    if (isMock) return (await mock()).mockListen.station(id);
    try {
      return await http<RadioStation>(`/radio/${encodeURIComponent(id)}`);
    } catch {
      return undefined;
    }
  },

  // ---------- lookups + peaks ----------
  /** A queue pick is only an id; this resolves it to the shared Track shape. */
  async track(id: string): Promise<Track | null> {
    if (isMock) return (await mock()).mockListen.track(id);
    try {
      return await http<Track>(`/tracks/${encodeURIComponent(id)}`);
    } catch {
      return null;
    }
  },
  /** null = no peaks (Spotify, radio, unknown id, or a local file with no audio). */
  peaks(trackId: string, buckets: number): Promise<PeaksResult | null> {
    const key = `${trackId}|${buckets}`;
    const hit = peakCache.get(key);
    if (hit) return hit;
    const p = (async (): Promise<PeaksResult | null> => {
      if (isMock) return (await mock()).mockListen.peaks(trackId, buckets);
      try {
        const res = await fetch(`/api/peaks/${encodeURIComponent(trackId)}?buckets=${buckets}`);
        if (!res.ok) return null;
        const raw = (await res.json()) as PeaksResult;
        // the server sends bytes (0–255); the waveform draws 0–1
        return { buckets: raw.buckets, data: raw.data.map((v) => v / 255) };
      } catch {
        return null;
      }
    })();
    peakCache.set(key, p);
    return p;
  },
  /** Warm the waveform cache for a track without caring about the result. */
  prefetchPeaks(trackId: string, buckets = 400): void {
    void listenApi.peaks(trackId, buckets).catch(() => undefined);
  },
};
