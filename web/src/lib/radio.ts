import type { Album, Track } from '@liner/shared';
import { api } from '../api';
import { listenApi } from '../listenApi';
import type { PlayItem } from './types';
import type { RadioFrom, RadioPick, RadioStation } from './listenTypes';
import { isLiveTrack } from './listenTypes';
import { usePlayer } from '../store/player';
import { useRadio } from '../store/radio';
import { useUi } from '../store/ui';

export { isLiveTrack };

const trackCache = new Map<string, Track | null>();
const albumCache = new Map<string, Album | null>();

async function loadTrack(id: string): Promise<Track | null> {
  if (trackCache.has(id)) return trackCache.get(id) ?? null;
  const t = await listenApi.track(id).catch(() => null);
  trackCache.set(id, t);
  return t;
}

async function loadAlbum(id: string): Promise<Album | null> {
  if (albumCache.has(id)) return albumCache.get(id) ?? null;
  const a = await api.album(id).catch(() => null);
  albumCache.set(id, a);
  return a;
}

/** /radio/start and /radio/next only return ids; fetch the tracks + their albums. */
export async function resolvePicks(picks: RadioPick[]): Promise<PlayItem[]> {
  const ids = [...new Set(picks.map((p) => p.trackId))];
  const tracks = await Promise.all(ids.map(loadTrack));
  const byId = new Map<string, Track>();
  for (const t of tracks) if (t) byId.set(t.id, t);
  const albumIds = [...new Set([...byId.values()].map((t) => t.albumId))];
  const albums = await Promise.all(albumIds.map(loadAlbum));
  const albumById = new Map<string, Album>();
  for (const a of albums) if (a) albumById.set(a.id, a);
  const out: PlayItem[] = [];
  for (const p of picks) {
    const track = byId.get(p.trackId);
    if (!track) continue;
    const album = albumById.get(track.albumId);
    out.push({
      track,
      album: { id: track.albumId, title: album?.title ?? 'Unknown album', coverUrl: album?.coverUrl },
    });
  }
  return out;
}

/** Start rune radio from a track / album / artist and play it on the current zone. */
export async function startRadio(from: RadioFrom, id: string): Promise<void> {
  try {
    const res = await listenApi.radioStart(from, id);
    const picks = res.picks.filter((p) => p.trackId);
    if (!picks.length) {
      useUi.getState().toast('Nothing in the library to start radio from');
      return;
    }
    const items = await resolvePicks(picks);
    if (!items.length) {
      useUi.getState().toast('Could not load the radio picks');
      return;
    }
    useRadio.getState().startSession(res.trackIds, picks);
    await usePlayer.getState().playItems(items, 0, { context: `radio:${from}:${id}` });
  } catch {
    useUi.getState().toast('Could not start radio — is the server reachable?');
  }
}

/** A live station as a queue item (server queue rows use the same shape). */
export function stationItem(station: RadioStation): PlayItem {
  const album = { id: station.id, title: station.name, coverUrl: station.logoUrl ?? station.favicon };
  const track = {
    id: station.id,
    albumId: station.id,
    source: 'radio',
    title: station.name,
    artists: [],
    disc: 1,
    number: 1,
    durationMs: 0,
    format: station.codec?.toLowerCase() === 'mp3' ? 'mp3' : 'other',
    bitrateKbps: station.bitrate || undefined,
  } as unknown as Track;
  return { track, album };
}

/** Play a live station on the current zone (pc = server/mpv, browser = <audio>). */
export async function playStation(station: RadioStation): Promise<void> {
  await usePlayer.getState().playItems([stationItem(station)], 0, { context: `radio:${station.id}` });
}
