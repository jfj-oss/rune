import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { formatDuration } from '../../lib/format';
import { barAt, peakBars, playedBars, seekTimeAt } from '../../lib/waveform';

interface Props {
  data: number[];
  positionMs: number;
  durationMs: number;
  onSeek(ms: number): void;
  className?: string;
}

/** Mirrored canvas waveform: played bars use the accent colour, hover shows the time. */
export function Waveform({ data, positionMs, durationMs, onSeek, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? positionMs;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(0, Math.round(r.width)), h: Math.max(0, Math.round(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#b3a7ff';
    const bars = peakBars(data, size.w, size.h, 1);
    const played = playedBars(bars.length, shown, durationMs);
    for (const b of bars) {
      ctx.fillStyle = b.index < played ? accent : 'rgba(255,255,255,0.27)';
      ctx.fillRect(b.x, b.top, b.width, b.height);
    }
  }, [data, size, shown, durationMs]);

  const at = (clientX: number) => {
    const el = ref.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    return { x, ms: seekTimeAt(x, r.width, durationMs), index: barAt(x, r.width, data.length) };
  };

  // a new song (new peaks) never keeps a drag from the previous one
  useEffect(() => { setDrag(null); }, [data]);

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e.clientX);
    if (!p) return;
    setDrag(p.ms);
    setHover({ x: p.x, ms: p.ms });
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = at(e.clientX);
    if (!p) return;
    setHover({ x: p.x, ms: p.ms });
    if (drag !== null) setDrag(p.ms);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    if (drag !== null) {
      const p = at(e.clientX);
      const ms = p ? p.ms : drag;
      setDrag(null);
      onSeek(ms);
    }
    setHover(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!durationMs) return;
    const step = 5_000;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = shown - step;
    else if (e.key === 'ArrowRight') next = shown + step;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = durationMs;
    if (next === null) return;
    e.preventDefault();
    onSeek(Math.max(0, Math.min(durationMs, next)));
  };

  const tipPct = size.w ? Math.max(0, Math.min(100, (hover?.x ?? 0) / size.w * 100)) : 0;

  return (
    <div
      ref={ref}
      className={`wave ${className}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1000)}
      aria-valuenow={Math.round(shown / 1000)}
      aria-valuetext={formatDuration(shown)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => { setDrag(null); setHover(null); }}
      onPointerLeave={() => { if (drag === null) setHover(null); }}
      onKeyDown={onKey}
    >
      <canvas ref={canvas} aria-hidden />
      {hover && durationMs > 0 && <span className="wave__tip" style={{ left: `${tipPct}%` }}>{formatDuration(hover.ms)}</span>}
    </div>
  );
}
