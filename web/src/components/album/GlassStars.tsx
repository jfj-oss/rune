import { useId } from 'react';

const STAR = 'M12 1.6l3.09 6.26 6.91 1-5 4.87 1.18 6.88L12 17.36l-6.18 3.25L7 13.73 2 8.86l6.91-1z';

type P = readonly [number, number];
/** The star's centre and its outer points / inner corners, in the same order as STAR. */
const C: P = [12, 12.1];
const OUTER: P[] = [[12, 1.6], [22, 8.86], [18.18, 20.61], [5.82, 20.61], [2, 8.86]];
const INNER: P[] = [[15.09, 7.86], [17, 13.73], [12, 17.36], [7, 13.73], [8.91, 7.86]];

/** One deep jewel tone per point, as [lit half, shaded half]: ruby, amber, emerald, sapphire, amethyst. */
const GLASS: [string, string][] = [
  ['#9b1b30', '#640e1e'],
  ['#a5621a', '#6e400c'],
  ['#17724a', '#0c472d'],
  ['#25488f', '#14295a'],
  ['#5f2a8a', '#3a185c'],
];

const tri = (a: P, b: P, c: P) => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}L${c[0]} ${c[1]}z`;

/** Each point is two panes: centre → inner corner before it → tip, and centre → tip → inner corner after it. */
const PANES = OUTER.flatMap((tip, k) => [
  { d: tri(C, INNER[(k + 4) % 5]!, tip), colour: GLASS[k]![0] },
  { d: tri(C, tip, INNER[k]!), colour: GLASS[k]![1] },
]);
/** The lead lines between panes: centre to every corner. */
const LEADS = [...OUTER, ...INNER].map((p) => `M${C[0]} ${C[1]}L${p[0]} ${p[1]}`).join('');

/** Five dark stained-glass stars lit to `value` (0–5, fractional). Decorative; the caller supplies the label. */
export function GlassStars({ value, size = 22 }: { value: number; size?: number }) {
  const id = useId().replace(/:/g, '');
  const v = Math.max(0, Math.min(5, value));
  const stars = [0, 1, 2, 3, 4];
  const at = (i: number) => `translate(${i * 27.6} 0)`;
  return (
    <svg className="gstars" width={size * 5 + 4 * 3} height={size} viewBox={`0 0 ${24 * 5 + 4 * 3.6} 24`} aria-hidden>
      <defs>
        {/* light coming through the glass: brightest in the middle of each star */}
        <radialGradient id={`${id}g`} cx="12" cy="11.5" r="10" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffe9c4" stopOpacity="0.34" />
          <stop offset="0.55" stopColor="#ffe9c4" stopOpacity="0.08" />
          <stop offset="1" stopColor="#ffe9c4" stopOpacity="0" />
        </radialGradient>
        {/* a faint glint on the upper-left panes */}
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`${id}c`}><rect x="0" y="0" width={fillWidth(v)} height="24" /></clipPath>
      </defs>
      {/* unlit glass: the same panes, almost black */}
      {stars.map((i) => (
        <g key={i} transform={at(i)}>
          <path d={STAR} fill="#0b0b0f" />
          {PANES.map((p, n) => <path key={n} d={p.d} fill={p.colour} fillOpacity="0.2" />)}
        </g>
      ))}
      {/* lit glass up to the score */}
      <g clipPath={`url(#${id}c)`}>
        {stars.map((i) => (
          <g key={i} transform={at(i)}>
            {PANES.map((p, n) => <path key={n} d={p.d} fill={p.colour} />)}
            <path d={STAR} fill={`url(#${id}g)`} />
            <path d={STAR} fill={`url(#${id}s)`} />
          </g>
        ))}
      </g>
      {/* the lead: between panes and around each star, over lit and unlit alike */}
      {stars.map((i) => (
        <g key={i} transform={at(i)} fill="none" stroke="#050507" strokeLinejoin="round" strokeLinecap="round">
          <path d={LEADS} strokeWidth="0.75" />
          <path d={STAR} strokeWidth="1.25" />
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
