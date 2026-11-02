import { Disc3, ListEnd, ListStart, Radio, User } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as RMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { contextMenuPosition } from '../lib/discover';
import { encId } from '../lib/format';
import type { PlayItem } from '../lib/types';
import { useDiscoverUi } from '../store/discoverUi';
import { usePlayer } from '../store/player';
import { AddToPlaylistItem } from './AddToPlaylist';
import { MenuItem } from './Popover';

/**
 * The shared track menu: every row (album, playlist, Tracks, search, queue,
 * Discover) renders these items, so "Song radio" is always in the same place.
 * `extra` appends row-specific actions such as "Remove from playlist".
 */
export function TrackMenuItems({ item, close, extra }: { item: PlayItem; close(): void; extra?: ReactNode }) {
  const nav = useNavigate();
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const openRadio = useDiscoverUi((s) => s.openRadio);

  return (
    <div role="menu" className="menu">
      <MenuItem icon={<Radio size={16} />} onClick={() => { close(); openRadio(item); }}>Song radio</MenuItem>
      <MenuItem icon={<ListStart size={16} />} onClick={() => { close(); void enqueueItems([item], true); }}>Play next</MenuItem>
      <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void enqueueItems([item]); }}>Add to queue</MenuItem>
      <AddToPlaylistItem close={close} target={{ what: item.track.title, resolve: () => [item] }} />
      <MenuItem icon={<Disc3 size={16} />} onClick={() => { close(); nav(`/album/${encId(item.album.id)}`); }}>Go to album</MenuItem>
      {item.track.artists[0] && (
        <MenuItem icon={<User size={16} />} onClick={() => { close(); nav(`/artist/${encId(item.track.artists[0]!.id)}`); }}>Go to artist</MenuItem>
      )}
      {extra}
    </div>
  );
}

/** `onContextMenu` for any track row: opens the shared menu at the cursor. */
export function trackMenuHandler(item: PlayItem) {
  return (e: RMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useDiscoverUi.getState().openTrackMenu(item, e.clientX, e.clientY);
  };
}

/** The fixed player chrome at the bottom of the window, so menus stay above it. */
function viewportBottom(): number {
  const bar = document.querySelector('.npbar, .tabs');
  const top = bar?.getBoundingClientRect().top;
  return top && top > 0 ? Math.min(window.innerHeight, top) : window.innerHeight;
}

/** One global cursor-positioned track menu, mounted by Shell. */
export function TrackContextMenu() {
  const menu = useDiscoverUi((s) => s.menu);
  const close = useDiscoverUi((s) => s.closeTrackMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu) { setPos(null); return; }
    const place = () => {
      const el = ref.current;
      setPos(contextMenuPosition(
        menu.x,
        menu.y,
        el?.offsetWidth ?? 240,
        el?.offsetHeight ?? 340,
        window.innerWidth,
        viewportBottom(),
      ));
    };
    place();
    const el = ref.current;
    const ro = el ? new ResizeObserver(place) : null;
    if (el) ro?.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', close, true);
    return () => { ro?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', close, true); };
  }, [menu, close]);

  useEffect(() => {
    if (!menu) return;
    ref.current?.focus();
    const down = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key, true); };
  }, [menu, close]);

  if (!menu) return null;
  const fallback = contextMenuPosition(menu.x, menu.y, 240, 340, window.innerWidth, viewportBottom());
  return createPortal(
    <div
      ref={ref}
      className="pop__panel ctxmenu"
      tabIndex={-1}
      aria-label="Track actions"
      style={{ left: (pos ?? fallback).left, top: (pos ?? fallback).top }}
    >
      <TrackMenuItems item={menu.item} close={close} />
    </div>,
    document.body,
  );
}
