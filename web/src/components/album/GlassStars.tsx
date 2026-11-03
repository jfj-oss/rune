import { useId } from 'react';

const STAR = 'M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.36l-6.18 3.25L7 13.73 2 8.86l6.91-1z';

/**
 * Five dark "liquid glass" stars lit to `value` (0–5, fractional): smoky translucent bodies with a thin
 * specular rim, brighter where lit. Decorative; the caller supplies the label.
 */
export function GlassStars({ value, size = 22 }: { value: number; size?: number }) {
  const id = useId().replace(/:/g, '');
  const v = Math.max(0, Math.min(5, value));
  const stars = [0, 1, 2, 3, 4];
  const at = (i: number) => `translate(${i * 27.6} 0)`;
  return (
    <svg className="gstars" width={size * 5 + 4 * 3} height={size} viewBox={`0 0 ${24 * 5 + 4 * 3.6} 24`} aria-hidden>
      <defs>
        {/* unlit: barely-there smoked glass */}
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.07" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.02" />
        </linearGradient>
        {/* lit: darker glass catching some light, a little clearer at the bottom */}
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.30" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.14" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.20" />
        </linearGradient>
        {/* the rim: bright on the upper-left edge, fading round to the lower-right, then a faint bounce */}
        <linearGradient id={`${id}r`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.32" />
        </linearGradient>
        {/* a soft inner sheen near the top */}
        <radialGradient id={`${id}s`} cx="10" cy="6" r="8" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={`${id}c`}><rect x="0" y="0" width={fillWidth(v)} height="24" /></clipPath>
      </defs>
      {stars.map((i) => (
        <path key={i} transform={at(i)} d={STAR} fill={`url(#${id}e)`} stroke={`url(#${id}r)`} strokeOpacity="0.4" strokeWidth="0.8" strokeLinejoin="round" />
      ))}
      <g clipPath={`url(#${id}c)`}>
        {stars.map((i) => (
          <g key={i} transform={at(i)}>
            <path d={STAR} fill={`url(#${id}f)`} />
            <path d={STAR} fill={`url(#${id}s)`} />
            <path d={STAR} fill="none" stroke={`url(#${id}r)`} strokeWidth="0.9" strokeLinejoin="round" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** x where the fill should stop: whole stars plus the fraction of the next one (star glyph spans x 2..22). */
function fillWidth(v: number): number {
  const whole = Math.floor(v);
  const frac = v - whole;
  return whole * 27.6 + (frac > 0 ? 2 + frac * 20 : 0);
}
