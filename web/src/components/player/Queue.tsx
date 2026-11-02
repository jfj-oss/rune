import { GripVertical, ListMusic, X } from 'lucide-react';
import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { formatDuration, formatTotalLength, plural } from '../../lib/format';
import { usePlayer } from '../../store/player';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';
import { Eq } from '../Eq';

const ROW = 60;

export function QueueList() {
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const [drag, setDrag] = useState<{ id: string; from: number; dy: number } | null>(null);
  const startY = useRef(0);
  const { queue, index, status } = state;

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

  if (!queue.length) {
    return (
      <div className="queue__empty">
        <ListMusic size={28} />
        <p>The queue is empty.</p>
        <p className="muted">Play an album, or add tracks with “Add to queue”.</p>
      </div>
    );
  }

  return (
    <ul className="queue__list" aria-label="Queue">
      {queue.map((q, i) => {
        const current = i === index;
        let shift = 0;
        if (drag) {
          if (i === drag.from) shift = drag.dy;
          else if (drag.from < target && i > drag.from && i <= target) shift = -ROW;
          else if (drag.from > target && i < drag.from && i >= target) shift = ROW;
        }
        return (
          <li
            key={q.queueId}
            className={`qrow${current ? ' is-current' : ''}${drag?.id === q.queueId ? ' is-dragging' : ''}`}
            style={{ height: ROW, transform: shift ? `translateY(${shift}px)` : undefined, transition: drag && drag.id !== q.queueId ? 'transform 150ms ease' : undefined }}
          >
            <button className="qrow__grip" aria-label="Drag to reorder" onPointerDown={(e) => onDown(e, q.queueId, i)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
              <GripVertical size={16} />
            </button>
            <button className="qrow__main" onClick={() => void command({ type: 'jump', index: i })}>
              <span className="qrow__art">
                <Cover album={q.album} />
                {current && <span className="qrow__eq"><Eq playing={status === 'playing'} /></span>}
              </span>
              <span className="qrow__txt">
                <span className="qrow__title">{q.track.title}</span>
                <span className="qrow__sub">{q.track.artists.map((a) => a.name).join(', ')} · {q.album.title}</span>
              </span>
              <span className="qrow__dur">{formatDuration(q.track.durationMs)}</span>
            </button>
            <button className="qrow__x btn-icon" aria-label={`Remove ${q.track.title}`} onClick={() => void command({ type: 'remove', queueId: q.queueId })}>
              <X size={16} />
            </button>
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
  const total = queue.reduce((n, q) => n + q.track.durationMs, 0);
  const remaining = queue.slice(Math.max(0, index)).reduce((n, q) => n + q.track.durationMs, 0);
  return (
    <aside className="queue" aria-label="Queue">
      <header className="queue__head">
        <div>
          <h2>Queue</h2>
          <p className="muted">{queue.length ? `${plural(queue.length, 'track')} · ${formatTotalLength(total)} · ${formatTotalLength(remaining)} left` : 'Nothing queued'}</p>
        </div>
        <div className="queue__actions">
          {queue.length > 0 && <button className="btn btn--ghost btn--sm" onClick={() => void command({ type: 'clear' })}>Clear</button>}
          <button className="btn-icon" aria-label="Close queue" onClick={onClose}><X size={20} /></button>
        </div>
      </header>
      <div className="queue__body"><QueueList /></div>
    </aside>
  );
}

export function QueueDrawer() {
  const open = useUi((s) => s.queueOpen);
  const set = useUi((s) => s.setQueueOpen);
  return (
    <>
      <div className={`drawer${open ? ' is-open' : ''}`} aria-hidden={!open} inert={!open}>
        <QueuePanel onClose={() => set(false)} />
      </div>
    </>
  );
}
