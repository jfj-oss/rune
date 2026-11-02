// API client for rune's own playlists (server/src/myplaylists). Kept apart from api.ts like browseApi.ts.
import { ApiError, http, isMock } from './api';
import type { EntryTrack, RunePlaylistDetail, SmartBody, SmartSpec } from './lib/playlists';

const mock = () => import('./mock/playlists');
const id = encodeURIComponent;

/** Mock mode throws plain errors with a status; make them look like the real client's. */
async function viaMock<T>(f: (m: Awaited<ReturnType<typeof mock>>['mockPlaylists']) => T, ms = 120): Promise<T> {
  const { mockPlaylists } = await mock();
  await new Promise((r) => setTimeout(r, ms));
  try { return f(mockPlaylists); } catch (e) { throw new ApiError((e as { status?: number }).status ?? 400, (e as Error).message); }
}

export const playlistApi = {
  async create(name: string, description?: string): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.create(name, description));
    return http('/playlists', { method: 'POST', body: JSON.stringify({ name, ...(description ? { description } : {}) }) });
  },
  async update(pid: string, patch: { name?: string; description?: string }): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.update(pid, patch));
    return http(`/playlists/${id(pid)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },
  async remove(pid: string): Promise<void> {
    if (isMock) return viaMock((m) => m.remove(pid));
    await http(`/playlists/${id(pid)}`, { method: 'DELETE' });
  },
  /** `tracks` are only used by mock mode (it has no track table); the server looks the ids up. */
  async addTracks(pid: string, trackIds: string[], tracks: EntryTrack[], position?: number): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.add(pid, tracks, position));
    return http(`/playlists/${id(pid)}/tracks`, { method: 'POST', body: JSON.stringify({ trackIds, ...(position !== undefined ? { position } : {}) }) });
  },
  /** `entryIds` (Spotify playlists' overlay rows) are sent instead of positions when given. */
  async removeTracks(pid: string, positions: number[], entryIds?: string[]): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.removeAt(pid, positions));
    return http(`/playlists/${id(pid)}/tracks`, { method: 'DELETE', body: JSON.stringify(entryIds ? { entryIds } : { positions }) });
  },
  async move(pid: string, from: number, to: number): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.move(pid, from, to));
    return http(`/playlists/${id(pid)}/move`, { method: 'POST', body: JSON.stringify({ from, to }) });
  },
  async duplicate(pid: string): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.duplicate(pid));
    return http(`/playlists/${id(pid)}/duplicate`, { method: 'POST', body: '{}' });
  },
  async createSmart(body: SmartBody): Promise<RunePlaylistDetail> {
    if (isMock) return viaMock((m) => m.createSmart(body.name, body));
    return http('/playlists/smart', { method: 'POST', body: JSON.stringify(body) });
  },
  /**
   * Live preview for the rule builder: `POST /api/playlists/smart/preview {rules,match,sort,limit}` -> `{count, sample?}`.
   * null = the server has no preview route (yet), so the dialog just hides the count.
   */
  async previewSmart(spec: SmartSpec): Promise<{ count: number; sample?: string[] } | null> {
    if (isMock) return viaMock((m) => m.previewSmart(spec), 200);
    try {
      return await http('/playlists/smart/preview', { method: 'POST', body: JSON.stringify(spec) });
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  },
  /** Download the playlist as an .m3u8 file. */
  async exportM3u8(pid: string, fallbackName: string): Promise<void> {
    let blob: Blob;
    let filename = `${fallbackName.replace(/[\\/:*?"<>|]+/g, '_') || 'playlist'}.m3u8`;
    if (isMock) {
      const x = await viaMock((m) => m.exportM3u8(pid), 60);
      blob = new Blob([x.content], { type: 'audio/x-mpegurl' });
    } else {
      const res = await fetch(`/api/playlists/${id(pid)}/export.m3u8`);
      if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
      const cd = /filename="?([^";]+)"?/.exec(res.headers.get('content-disposition') ?? '');
      if (cd?.[1]) filename = cd[1];
      blob = await res.blob();
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
  /** POST an .m3u8 file's text as a new playlist. */
  async importM3u8(content: string, name?: string): Promise<RunePlaylistDetail & { imported?: number; skipped?: number }> {
    if (isMock) return viaMock((m) => { const d = m.create(name || 'Imported playlist'); return { ...d, imported: 0, skipped: content.split('\n').filter((l) => l && !l.startsWith('#')).length }; });
    return http('/playlists/import', { method: 'POST', body: JSON.stringify({ content, ...(name ? { name } : {}) }) });
  },
};
