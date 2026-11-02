import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ListMusic } from 'lucide-react';
import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useCoverColor } from '../../hooks/useCoverColor';
import { useIsDesktop } from '../../hooks/useMedia';
import { encId, formatDuration } from '../../lib/format';
import { currentItem, usePlayer, useSignalPath } from '../../store/player';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';
import { SeekBar, SignalDot, Transport, VolumeControl, ZonePicker } from './parts';

function excerpt(s: string, n = 260) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

export function NowPlaying() {
  const open = useUi((s) => s.nowPlayingOpen);
  const setOpen = useUi((s) => s.setNowPlayingOpen);
  const setQueue = useUi((s) => s.setQueueOpen);
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const cur = currentItem(state);
  const desktop = useIsDesktop();
  const nav = useNavigate();
  const tint = useCoverColor(cur?.album);
  const { steps, tone } = useSignalPath();
  const [dy, setDy] = useState(0);
  const touch = useRef<{ y: number; x: number; ok: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const details = useQuery({
    queryKey: ['details', cur?.album.id],
    queryFn: () => api.details(cur!.album.id),
    enabled: open && !!cur,
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, setOpen]);

  if (!open) return null;

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touch.current = { y: t.clientY, x: t.clientX, ok: (bodyRef.current?.scrollTop ?? 0) <= 0 };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    const s = touch.current;
    if (!t || !s || !s.ok) return;
    const d = t.clientY - s.y;
    if (d > 0 && Math.abs(d) > Math.abs(t.clientX - s.x)) setDy(d);
  };
  const onTouchEnd = () => {
    if (dy > 110) setOpen(false);
    setDy(0);
    touch.current = null;
  };

  const about = details.data?.reception?.value ?? details.data?.background?.value;
  const upNext = state.queue.slice(state.index + 1, state.index + 4);
  const title = cur?.track.title ?? 'Nothing playing';

  return (
    <div
      className="np"
      role="dialog"
      aria-label="Now Playing"
      style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: dy ? 'none' : undefined, ['--tint' as string]: tint }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="np__bg" aria-hidden>
        {cur && <Cover album={cur.album} size={200} className="np__bgimg" eager />}
        <div className="np__bgwash" />
      </div>

      <header className="np__top">
        <button className="btn-icon btn-icon--lg" aria-label="Close Now Playing" onClick={() => setOpen(false)}><ChevronDown size={26} /></button>
        <div className="np__topcenter">
          <span className="eyebrow">Now playing</span>
          {cur && <Link to={`/album/${encId(cur.album.id)}`} className="np__topalbum" onClick={() => setOpen(false)}>{cur.album.title}</Link>}
        </div>
        <div className="np__topright">
          <ZonePicker placement="bottom-end" compact={!desktop} />
          {!desktop && (
            <button className="btn-icon btn-icon--lg" aria-label="Queue" onClick={() => { setOpen(false); setQueue(true); }}><ListMusic size={22} /></button>
          )}
        </div>
      </header>

      <div className="np__body" ref={bodyRef}>
        <div className="np__art">
          {cur ? <Cover album={cur.album} size={600} eager className="np__cover" sizes="min(60vh, 50vw)" /> : <div className="cover np__cover" />}
        </div>

        <div className="np__panel">
          <h1 className="np__title">{title}</h1>
          {cur && (
            <p className="np__sub">
              {cur.track.artists.map((a, i) => (
                <span key={a.id}>{i > 0 && ', '}<Link className="link link--strong" to={`/artist/${encId(a.id)}`} onClick={() => setOpen(false)}>{a.name}</Link></span>
              ))}
              <span className="dim"> · </span>
              <Link className="link" to={`/album/${encId(cur.album.id)}`} onClick={() => setOpen(false)}>{cur.album.title}</Link>
            </p>
          )}

          <SeekBar className="seek--np" />
          <div className="np__transport"><Transport big /></div>
          <div className="np__vol"><VolumeControl /></div>

          <div className="np__signal">
            <SignalDot withLabel placement="top-start" />
            {steps.length > 0 && <span className={`np__path np__path--${tone}`}>{steps.join(' → ')}</span>}
          </div>

          {upNext.length > 0 && (
            <section className="np__sec">
              <h2 className="eyebrow">Up next</h2>
              <ul className="np__next">
                {upNext.map((q, i) => (
                  <li key={q.queueId}>
                    <button onClick={() => void command({ type: 'jump', index: state.index + 1 + i })}>
                      <Cover album={q.album} sizes="40px" />
                      <span className="np__nexttxt"><b>{q.track.title}</b><span>{q.track.artists.map((a) => a.name).join(', ')}</span></span>
                      <span className="np__nextdur">{formatDuration(q.track.durationMs)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {cur && about && (
            <section className="np__sec">
              <h2 className="eyebrow">About this album</h2>
              <button className="np__about" onClick={() => { setOpen(false); nav(`/album/${encId(cur.album.id)}#review`); }}>
                <p className="prose">{excerpt(about)}</p>
                <span className="link">Read more on the album page →</span>
              </button>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
