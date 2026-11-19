import type { PlayerState } from '@liner/shared';

export const RELOAD_NOTICE = 'rune was updated — reload this page';

export type HelloAction = 'none' | 'notice';

/** What this tab does with the server's hello: a tab built from another web build is told to reload (never while it is the one making sound). */
export function helloAction(hello: { build: string | null }, tab: { build: string; playingHere: boolean; dev?: boolean }): HelloAction {
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
