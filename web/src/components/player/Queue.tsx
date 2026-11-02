import { useVirtualizer } from '@tanstack/react-virtual';
import { GripVertical, ListMusic, ListPlus, MoreHorizontal, TriangleAlert, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react';
import { formatDuration, formatTotalLength, plural } from '../../lib/format';
import { isLiveTrack } from '../../lib/listenTypes';
import { liveSubtitle } from '../../lib/live';
import { isMixedQueue } from '../../player/pc';
import { queueName } from '../../lib/playlists';
import { usePlayer } from '../../store/player';
import { usePlaylistUi } from '../../store/playlistUi';
import { useRadio } from '../../store/radio';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';
import { Eq } from '../Eq';
import { MenuItem, Popover } from '../Popover';
import { TrackMenuItems, trackMenuHandler } from '../TrackMenu';

const ROW = 60;

export function QueueList({ scrollRef }: { scrollRef: RefObject<HTMLDivElement | null> }) {
  // Only the fields the rows use: a position tick leaves the queue untouched, so it costs no re-render.
  const queue = usePlayer((s) => s.state.queue);
  const index = usePlayer((s) => s.state.index);
  const status = usePlayer((s) => s.state.status);
  const nowPlaying = usePlayer((s) => s.state.nowPlaying);
  const command = usePlayer((s) => s.command);
  const reasons = useRadio((s) => s.reasons);
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number } | null>(null);
  const startY = useRef(0);

  const target = drag ? Math.max(0, Math.min(queue.length - 1, drag.from + Math.round(drag.dy / ROW))) : -1;

  const onDown = (e: RPointerEvent<HTMLButtonElement>, id: string, from: number) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startY.current = e.clientY;
    setDrag({ id, from, dy: 0 });
  };
  const onMove = (e: RPointerEvent<HTMLButtonElement>) => {
    if (drag) setDrag({ ...drag, dy: e.clientY - startY.current });
  };
  const onUp = () => {
    if (drag && target !== drag.from) void command({ type: 'move', queueId: drag.id, toIndex: target });
    setDrag(null);
  };

  // Rows are fixed-height (60 px, 64 px on phones), so only the visible window is mounted.
  const v = useVirtualizer({
    count: queue.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 6,
  });
  useEffect(() => { v.measure(); }, [v]);

  if (!queue.length) {
    return (
      <div className="queue__empty">
        <ListMusic size={28} />
        <p>The queue is empty.</p>
        <p className="muted">Play an album, or add tracks with “Add to queue”.</p>
      </div>
    );
  }

  const vis = v.getVirtualItems();
  return (
    <ul className="queue__list" aria-label="Queue" style={{ height: v.getTotalSize() }}>
      {vis.map((row) => {
        const i = row.index;
        const q = queue[i]!;
        const current = i === index;
        const live = isLiveTrack(q.track);
        const reason = reasons[q.track.id];
        let shift = 0;
        if (drag) {
          if (i === drag.from) shift = drag.dy;
          else if (drag.from < target && i > drag.from && i <= target) shift = -ROW;
          else if (drag.from > target && i < drag.from && i >= target) shift = ROW;
        }
        return (
          <li
            key={q.queueId}
            ref={v.measureElement}
            data-index={row.index}
            className={`qrow${current ? ' is-current' : ''}${drag?.id === q.queueId ? ' is-dragging' : ''}`}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW, transform: `translateY(${row.start + shift}px)`, transition: drag && drag.id !== q.queueId ? 'transform 150ms ease' : undefined }}
            onContextMenu={trackMenuHandler({ track: q.track, album: q.album })}
          >
            <button className="qrow__grip" aria-label="Drag to reorder" onPointerDown={(e) => onDown(e, q.queueId, i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
              <GripVertical size={16} />
            </button>
            <button className="qrow__main" onClick={() => void command({ type: 'jump', index: i })}>
              <span className="qrow__art">
                <Cover album={q.album} sizes="40px" src={live ? q.album.coverUrl ?? null : undefined} />
                {current && <span className="qrow__eq"><Eq playing={status === 'playing'} /></span>}
              </span>
              <span className="qrow__txt">
                <span className="qrow__title">{q.track.title}</span>
                <span className="qrow__sub">{live ? liveSubtitle({ nowPlaying }, q) || 'Internet radio' : `${q.track.artists.map((a) => a.name).join(', ')} · ${q.album.title}`}</span>
                {reason && <span className="qrow__reason">{reason}</span>}
              </span>
              <span className="qrow__dur">{live ? <span className="livepill livepill--sm"><i />LIVE</span> : formatDuration(q.track.durationMs)}</span>
            </button>
            <button className="qrow__x btn-icon" aria-label={`Remove ${q.track.title}`} onClick={() => void command({ type: 'remove', queueId: q.queueId })}>
              <X size={16} />
            </button>
            <Popover
              className="qrow__menu"
              placement="bottom-end"
              trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${q.track.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
            >
              {(close) => (
                <TrackMenuItems
                  item={{ track: q.track, album: q.album }}
                  close={close}
                  extra={<MenuItem icon={<X size={16} />} danger onClick={() => { close(); void command({ type: 'remove', queueId: q.queueId }); }}>Remove from queue</MenuItem>}
                />
              )}
            </Popover>
          </li>
        );
      })}
    </ul>
  );
}

export function QueuePanel({ onClose }: { onClose(): void }) {
  const queue = usePlayer((s) => s.state.queue);
  const index = usePlayer((s) => s.state.index);
  const command = usePlayer((s) => s.command);
  const onPc = usePlayer((s) => s.zones.find((z) => z.id === s.zone)?.kind === 'pc');
  const body = useRef<HTMLDivElement>(null);
  const total = queue.reduce((n, q) => n + q.track.durationMs, 0);
  const save = () => usePlaylistUi.getState().openPicker({
    title: 'Save queue as playlist',
    what: `The queue · ${plural(queue.length, 'track')}`,
    newName: queueName(),
    resolve: () => usePlayer.getState().state.queue.map((q) => ({ track: q.track, album: q.album })),
  });
  const remaining = queue.slice(Math.max(0, index)).reduce((n, q) => n + q.track.durationMs, 0);
  return (
    <aside className="queue" aria-label="Queue">
      <header className="queue__head">
        <div>
          <h2>Queue</h2>
          <p className="muted">{queue.length ? `${plural(queue.length, 'track')} · ${formatTotalLength(total)} · ${formatTotalLength(remaining)} left` : 'Nothing queued'}</p>
        </div>
        <div className="queue__actions">
          {queue.length > 0 && <button className="btn-icon" aria-label="Save queue as playlist" title="Save queue as playlist" onClick={save}><ListPlus size={19} /></button>}
          {queue.length > 0 && <button className="btn btn--ghost btn--sm" onClick={() => void command({ type: 'clear' })}>Clear</button>}
          <button className="btn-icon" aria-label="Close queue" onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      {onPc && isMixedQueue(queue) && (
        <p className="queue__note" role="note"><TriangleAlert size={14} /> Mixed queue on the PC speakers: keep a rune tab open so it can switch between local files and Spotify.</p>
      )}
      <div className="queue__body" ref={body}><QueueList scrollRef={body} /></div>
    </aside>
  );
}

export function QueueDrawer() {
  const open = useUi((s) => s.queueOpen);
  const set = useUi((s) => s.setQueueOpen);
  // Mount the panel (and its virtualized list) only while open; keep it for the closing slide.
  const [mounted, setMounted] = useState(open);
  useLayoutEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  return (
    <div className={`drawer${open ? ' is-open' : ''}`} aria-hidden={!open} inert={!open}>
      {mounted && <QueuePanel onClose={() => set(false)} />}
    </div>
  );
}
