import { create } from 'zustand';
import { api, isMock } from '../api';
import { devicePlace, sdkSupported } from '../lib/device';
import type { PlayItem, PlaySource } from '../lib/types';
import { SpotifySdkEngine, type SdkStatus } from '../player/spotifySdk';
import type { Caps } from '../player/routing';

/** A pending "where should this play?" question. */
export interface ChooserRequest {
  items: PlayItem[];
  startIndex: number;
  shuffle?: boolean;
  /** Which kind of tracks could not play on the current zone. */
  need: PlaySource;
  /** spotify:playlist:… etc. for "Open in Spotify" when the items alone don't say what to open. */
  context?: string;
}

interface SpotifyStore {
  loaded: boolean;
  connected: boolean;
  user?: { name: string; product: string };
  supported: boolean;
  sdk: SdkStatus;
  chooser: ChooserRequest | null;
  /** Session memory: where the user last sent Spotify / local tracks that their zone couldn't play. */
  choices: Partial<Record<PlaySource, string>>;
  init(): Promise<void>;
  askWhere(req: ChooserRequest): void;
  closeChooser(): void;
  remember(need: PlaySource, zone: string | undefined): void;
}

/** The Spotify device name of this tab, as every other device sees it: "rune in the browser (Mac)". */
export const sdkName = () => `rune in the browser (${devicePlace()})`;
let engine: SpotifySdkEngine | null = null;
/** The one Web Playback SDK engine of this tab (the browser zone's Spotify half). */
export function getSdkEngine(): SpotifySdkEngine {
  if (!engine) {
    engine = new SpotifySdkEngine(sdkName());
    engine.onStatus((sdk) => useSpotify.setState({ sdk }));
  }
  return engine;
}

function loadChoices(): SpotifyStore['choices'] {
  try { return JSON.parse(sessionStorage.getItem('rune.playOn') ?? '{}') as SpotifyStore['choices']; } catch { return {}; }
}

export const useSpotify = create<SpotifyStore>((set, get) => ({
  loaded: false,
  connected: false,
  supported: false,
  sdk: { phase: 'off', deviceId: null },
  chooser: null,
  choices: loadChoices(),

  async init() {
    if (get().loaded) return;
    const st = await api.spotifyStatus();
    const supported = isMock ? true : sdkSupported();
    set({ loaded: true, connected: st.connected, user: st.user, supported, ...(isMock ? { sdk: { phase: 'ready' as const, deviceId: 'mock-sdk' } } : {}) });
    // Register this tab as a Spotify device as soon as we know the account is connected.
    if (!isMock && st.connected && supported) void getSdkEngine().activate().catch(() => undefined);
  },
  askWhere: (chooser) => set({ chooser }),
  closeChooser: () => set({ chooser: null }),
  remember(need, zone) {
    const choices = { ...get().choices, [need]: zone };
    if (!zone) delete choices[need];
    try { sessionStorage.setItem('rune.playOn', JSON.stringify(choices)); } catch { /* storage blocked */ }
    set({ choices });
  },
}));

/** Can this tab play Spotify through the Web Playback SDK right now? */
export function capsFrom(s: Pick<SpotifyStore, 'connected' | 'supported' | 'sdk'>): Caps {
  return { sdk: s.connected && s.supported && s.sdk.phase !== 'error' };
}
export const useCaps = (): Caps => {
  const connected = useSpotify((s) => s.connected);
  const supported = useSpotify((s) => s.supported);
  const phase = useSpotify((s) => s.sdk.phase);
  return { sdk: connected && supported && phase !== 'error' };
};
