import { useId } from 'react';

const STAR = 'M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.36l-6.18 3.25L7 13.73 2 8.86l6.91-1z';

/** Five frosted-glass stars filled to `value` (0–5, fractional). Decorative; the caller supplies the label. */
export function GlassStars({ value, size = 22 }: { value: number; size?: number }) {
  const id = useId().replace(/:/g, '');
  const v = Math.max(0, Math.min(5, value));
  return (
    <svg className="gstars" width={size * 5 + 4 * 3} height={size} viewBox={`0 0 ${24 * 5 + 4 * 3.6} 24`} aria-hidden>
      <defs>
        {/* empty glass: faint frosted body */}
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.06" />
        </linearGradient>
        {/* filled glass: bright, milky at the top, clearer below */}
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.78" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.42" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.26" />
        </linearGradient>
        {/* the sheen: a soft highlight across the upper-left of each star */}
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="0.42" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}c`}><rect x="0" y="0" width={fillWidth(v)} height="24" /></clipPath>
      </defs>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} transform={`translate(${i * 27.6} 0)`}>
          <path d={STAR} fill={`url(#${id}e)`} stroke="#fff" strokeOpacity="0.32" strokeWidth="0.9" strokeLinejoin="round" />
        </g>
      ))}
      <g clipPath={`url(#${id}c)`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i} transform={`translate(${i * 27.6} 0)`}>
            <path d={STAR} fill={`url(#${id}f)`} stroke="#fff" strokeOpacity="0.95" strokeWidth="1.1" strokeLinejoin="round" />
          </g>
        ))}
      </g>
      {[0, 1, 2, 3, 4].map((i) => (
        <g key={i} transform={`translate(${i * 27.6} 0)`}>
          <path d={STAR} fill={`url(#${id}s)`} transform="translate(12 12) scale(0.72) translate(-12 -11)" />
        </g>
      ))}
    </svg>
  );
}

/** x where the fill should stop: whole stars plus the fraction of the next one (star glyph spans x 2..22). */
function fillWidth(v: number): number {
  const whole = Math.floor(v);
  const frac = v - whole;
  return whole * 27.6 + (frac > 0 ? 2 + frac * 20 : 0);
}
