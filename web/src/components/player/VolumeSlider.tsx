import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { formatVolume, posToVolume, snapVolume, stepVolume, volumeToPos } from '../../lib/volume';

interface Props {
  value: number; // volume 0..100
  onChange(v: number): void;
  onCommit?(v: number): void;
  className?: string;
}

const RES = 1000; // native range resolution along the slider position
const WHEEL_PX = 80; // accumulated wheel delta per step

/** Volume slider: position is perceptual (left half = 0..25 %), see lib/volume. */
export function VolumeSlider({ value, onChange, onCommit, className = '' }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef({ value, onChange, onCommit });
  live.current = { value, onChange, onCommit };
  const [wheeling, setWheeling] = useState(false);

  // Wheel / trackpad scroll adjusts the volume (needs a non-passive listener to stop page scroll).
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let acc = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : -e.deltaX;
      if (!d) return;
      e.preventDefault();
      acc += e.deltaMode === 1 ? d * 33 : d;
      const n = Math.trunc(acc / WHEEL_PX);
      if (n !== 0) {
        acc -= n * WHEEL_PX;
        let v = live.current.value;
        for (let i = 0; i < Math.abs(n); i++) v = stepVolume(v, n < 0 ? 1 : -1, e.shiftKey);
        live.current.value = v;
        live.current.onChange(v);
      }
      setWheeling(true);
      clearTimeout(timer);
      timer = setTimeout(() => { setWheeling(false); live.current.onCommit?.(live.current.value); }, 350);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(timer); };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = stepVolume(value, 1, e.shiftKey);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = stepVolume(value, -1, e.shiftKey);
    else if (e.key === 'PageUp') next = stepVolume(value, 1, true);
    else if (e.key === 'PageDown') next = stepVolume(value, -1, true);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    if (next === null) return;
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  const pos = volumeToPos(value);
  return (
    <div ref={wrap} className={`vslider${wheeling ? ' is-active' : ''} ${className}`} style={{ '--f': pos } as CSSProperties}>
      <input
        type="range"
        className="slider slider--vol"
        min={0}
        max={RES}
        step={1}
        value={Math.round(pos * RES)}
        aria-label="Volume"
        aria-valuetext={formatVolume(value)}
        onChange={(e) => {
          const v = snapVolume(posToVolume(Number(e.target.value) / RES));
          if (v !== value) onChange(v);
        }}
        onKeyDown={onKeyDown}
        onPointerUp={() => onCommit?.(live.current.value)}
        onKeyUp={() => onCommit?.(live.current.value)}
      />
      <i className="vslider__tick" aria-hidden="true"><b>25%</b></i>
      <span className="vslider__tip" aria-hidden="true">{formatVolume(value)}</span>
    </div>
  );
}
