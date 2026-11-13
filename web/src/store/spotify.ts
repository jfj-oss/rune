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
  /** Epoch ms until which Spotify refuses rune's requests (its daily limit); null while it answers. */
  restingUntil: number | null;
  /** Permission names the login granted (from /spotify/status); null until known or on an older server. */
  scopes: string[] | null;
  /** Session memory: where the user last sent Spotify / local tracks that their zone couldn't play. */
  choices: Partial<Record<PlaySource, string>>;
  /** `sdk: false`: this page must not become a Spotify player (a tab on the PC itself, where Soloist plays). */
  init(opts?: { sdk?: boolean }): Promise<void>;
  /** Re-read /spotify/status (connected, resting): the "Play on…" sheet does this when it opens. */
  refreshStatus(): Promise<void>;
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

/** A resting time still ahead of us, else null (an old server sends none). */
const restingFrom = (st: { restingUntil?: number | null }): number | null =>
  typeof st.restingUntil === 'number' && st.restingUntil > Date.now() ? st.restingUntil : null;

/** "Spotify is resting until 14:35": the one line every page shows while Spotify's daily limit is used up. */
export function restingNotice(until: number | null, now = Date.now()): string | null {
  if (until === null || until <= now) return null;
  const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `Spotify is resting until ${at} — its daily limit is used up. Spotify songs play again then; local music works now.`;
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
  restingUntil: null,
  scopes: null,
  choices: loadChoices(),

  async init(opts) {
    if (get().loaded) return;
    const st = await api.spotifyStatus();
    const supported = isMock ? true : opts?.sdk !== false && sdkSupported();
    set({ loaded: true, connected: st.connected, user: st.user, supported, restingUntil: restingFrom(st), scopes: Array.isArray(st.scopes) ? st.scopes : null, ...(isMock ? { sdk: { phase: 'ready' as const, deviceId: 'mock-sdk' } } : {}) });
    // Register this tab as a Spotify device as soon as we know the account is connected.
    if (!isMock && st.connected && supported) void getSdkEngine().activate().catch(() => undefined);
  },
  async refreshStatus() {
    if (isMock) return;
    try {
      const st = await api.spotifyStatus();
      set({ connected: st.connected, user: st.user, restingUntil: restingFrom(st), scopes: Array.isArray(st.scopes) ? st.scopes : null });
    } catch { /* offline: keep what we have */ }
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
