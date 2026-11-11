/** Pure helpers for the setup page (kept out of the component so they can be tested). */

export interface SetupStatus {
  needsSetup: boolean;
  libraryRoots: string[];
  port: number;
  redirectUri: string;
  spotifyClientId: string;
  spotifyActive: boolean;
  spotifyPending: boolean;
  rootsPending: boolean;
  publicUrl: string;
  configFile: string;
  home: string;
  canRestart: boolean;
  soloist: { binary: string; binaryInstalled: boolean; keyFile: string; keySaved: boolean; deviceName: string; run: string | null };
}

export interface PairState { running: boolean; output: string; exitCode: number | null; startedAt: number }
export interface DirList { path: string; parent: string | null; dirs: string[] }

/** The redirect URIs to paste into the Spotify dashboard: always the loopback one, plus the phone address's when set. */
export function redirectUris(s: Pick<SetupStatus, 'redirectUri' | 'publicUrl'>): string[] {
  const list = [s.redirectUri];
  const pub = s.publicUrl.trim().replace(/\/+$/, '');
  if (pub) list.push(`${pub}/api/spotify/callback`);
  return list;
}

/** A Spotify client ID is 32 hex characters. */
export function validClientId(id: string): boolean {
  return /^[0-9a-f]{32}$/i.test(id.trim());
}

/** The one command that serves rune over HTTPS inside the user's tailnet. */
export function tailscaleServeCommand(port: number): string {
  return `tailscale serve --bg --https=8445 http://127.0.0.1:${port}`;
}

/** Is any change saved that only a restart applies? */
export function needsRestart(s: SetupStatus, keyJustSaved: boolean): boolean {
  return s.rootsPending || s.spotifyPending || keyJustSaved;
}
