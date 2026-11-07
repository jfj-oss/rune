// Phase 3 (server config spotify.serverQueue): the pc zone's queue lives on the server, and this page is a plain
// remote for it. The server's websocket hello says which web build it serves and whether that mode is on.
import type { PlayerState } from '@liner/shared';
import type { ZoneInfo } from '../lib/types';

/** Is this the pc zone with its queue on the server? */
export const usesServerQueue = (z: Pick<ZoneInfo, 'kind' | 'serverQueue'> | undefined): boolean => !!z && z.kind === 'pc' && z.serverQueue === true;

export const RELOAD_NOTICE = 'rune was updated — reload this page';

export type HelloAction = 'none' | 'notice' | 'reload';

/**
 * What this tab does with the server's hello. A tab that drives the pc zone the other way (its own mixed queue, or a
 * plain remote when the server no longer keeps the queue) must not go on: it reloads, unless music plays in this very
 * tab (then it is told to). A tab from another web build is told to reload.
 */
export function helloAction(
  hello: { build: string | null; serverQueue: boolean },
  tab: { build: string; pcServerQueue: boolean | null; playingHere: boolean; dev?: boolean },
): HelloAction {
  if (tab.pcServerQueue !== null && tab.pcServerQueue !== hello.serverQueue) return tab.playingHere ? 'notice' : 'reload';
  if (!tab.dev && hello.build && hello.build !== tab.build) return 'notice';
  return 'none';
}

/** The page's one line when the server queue stops for a reason (rate limit, another player, no Spotify app). */
export function holdNotice(prev: PlayerState | undefined, next: PlayerState): string | null {
  const h = next.hold;
  if (!h) return null;
  if (prev?.zone === next.zone && prev.hold?.reason === h.reason) return null;
  return h.message;
}
