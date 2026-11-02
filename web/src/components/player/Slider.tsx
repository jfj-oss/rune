import type { CSSProperties } from 'react';

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
  const commit = (el: HTMLInputElement) => onCommit?.(Number(el.value));
  return (
    <input
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
      onPointerUp={(e) => commit(e.currentTarget)}
      onKeyUp={(e) => commit(e.currentTarget)}
    />
  );
}
