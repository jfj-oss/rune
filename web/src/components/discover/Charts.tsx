import { useId, type ReactNode } from 'react';
import { formatListening, normalizeBars, sparklinePath, type DayStat } from '../../lib/discover';

/** Smooth-ish area sparkline over the listener's daily history. */
export function Sparkline({ points, label = 'Listening over time', height = 110 }: { points: DayStat[]; label?: string; height?: number }) {
  const id = useId().replace(/[:]/g, '');
  const w = 640;
  const pad = 4;
  const path = sparklinePath(points, w, height, pad);
  const area = path ? `${path} L ${w - pad} ${height - pad} L ${pad} ${height - pad} Z` : '';
  if (!path) return <p className="muted secnote">No listening history for this period yet.</p>;
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${w} ${height}`}
      role="img"
      aria-label={label}
      preserveAspectRatio="none"
      style={{ height }}
    >
      <defs>
        <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line className="spark__base" x1={pad} y1={height - pad} x2={w - pad} y2={height - pad} />
      {area && <path d={area} fill={`url(#sp-${id})`} />}
      <path d={path} className="spark__line" />
    </svg>
  );
}

interface BarsProps {
  /** Values in ms; bars are scaled to the tallest. */
  values: number[];
  labels: string[];
  /** Show one label every N bars (24-hour charts get every 6th). */
  labelEvery?: number;
  ariaLabel: string;
}

export function Bars({ values, labels, labelEvery = 1, ariaLabel }: BarsProps) {
  const scaled = normalizeBars(values);
  return (
    <div className="barsblock">
      <div className="bars" role="img" aria-label={ariaLabel}>
        {values.map((v, i) => {
          const label = labels[i] ?? '';
          return (
            <span key={i} className="bar" title={`${label}: ${formatListening(v)}`} aria-label={`${label}: ${formatListening(v)}`}>
              <i style={{ height: `${scaled[i] ? Math.max(3, (scaled[i] as number) * 100) : 1.5}%` }} />
            </span>
          );
        })}
      </div>
      <div className="barlabels" aria-hidden>
        {labels.map((l, i) => <span key={i}>{i % labelEvery === 0 ? l : ''}</span>)}
      </div>
    </div>
  );
}

export function StatTile({ icon, label, value, sub }: { icon?: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stathero">
      {icon ? <span className="stathero__icon" aria-hidden>{icon}</span> : null}
      <span className="stathero__v">{value}</span>
      <span className="stathero__k">{label}</span>
      {sub ? <span className="stathero__sub">{sub}</span> : null}
    </div>
  );
}
