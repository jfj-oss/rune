import { http } from './api';
import type { DirList, PairState, SetupStatus } from './lib/setup';

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const setupApi = {
  status: () => http<SetupStatus>('/setup/status'),
  dirs: (path?: string) => http<DirList>(`/setup/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  saveConfig: (patch: { libraryRoots?: string[]; spotifyClientId?: string; publicUrl?: string }) =>
    http<{ ok: true; restartNeeded: boolean }>('/setup/config', json(patch)),
  saveKey: (key: string) => http<{ ok: true }>('/setup/soloist-key', json({ key })),
  pair: () => http<PairState>('/setup/soloist-pair', { method: 'POST' }),
  pairState: () => http<PairState>('/setup/soloist-pair'),
  restart: () => http<{ ok: true; restarting: boolean }>('/setup/restart', { method: 'POST' }),
};
