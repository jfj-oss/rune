import { useEffect, useRef, type CSSProperties } from 'react';

interface Props {
  value: number;
  max: number;
  onChange(v: number): void;
  onCommit?(v: number): void;
  label: string;
  className?: string;
  step?: number;
  disabled?: boolean;
}

/** Range input with a filled track; commit fires on release / key-up. */
export function Slider({ value, max, onChange, onCommit, label, className = '', step = 1, disabled }: Props) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const ref = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  // The browser's own "change" event fires once the value is settled (end of a drag, a click
  // on the track, a key press). Pointer-up alone is not reliable on range inputs: after a plain
  // click it can be swallowed, which left the seek bar frozen at the clicked spot.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fire = () => commitRef.current?.(Number(el.value));
    el.addEventListener('change', fire);
    return () => el.removeEventListener('change', fire);
  }, []);
  return (
    <input
      ref={ref}
      type="range"
      className={`slider ${className}`}
      style={{ '--p': `${pct}%` } as CSSProperties}
      min={0}
      max={max || 1}
      step={step}
      value={Math.min(value, max || 1)}
      aria-label={label}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
