// The playlists chosen for the rune mini (the small desktop player): at most 8, each with a coloured dot.
import type { MiniPlaylist } from '@liner/shared';

export const MINI_MAX = 8;

/** The mini's dot colours, by `MiniPlaylist.color` (native/linux/app/src/look.rs DOTS, native/mac Theme.swift). */
export const MINI_COLORS = ['#C9785A', '#C9A45A', '#8FAE6B', '#5FA89A', '#6B93C0', '#9483C4', '#C07BA8', '#9A9488'];
export const miniColor = (c: number): string => MINI_COLORS[((c % MINI_COLORS.length) + MINI_COLORS.length) % MINI_COLORS.length]!;

export const isOnMini = (list: readonly MiniPlaylist[] | undefined, id: string): boolean => !!list?.some((p) => p.id === id);

/** The list after moving the item at `from` to `to` (a new array; out-of-range moves change nothing). */
export function moveMini<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** The list as the server will have it after `id` is switched on (at the end) or off, for showing the change at once. */
export function withMini(list: readonly MiniPlaylist[], id: string, name: string, on: boolean): MiniPlaylist[] {
  if (!on) return list.filter((p) => p.id !== id);
  if (list.some((p) => p.id === id)) return [...list];
  const used = new Set(list.map((p) => p.color));
  let color = 0;
  while (used.has(color)) color++;
  return [...list, { id, name, color }];
}
