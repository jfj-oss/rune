import { lazy, Suspense } from 'react';
import type { DitherColour } from '../lib/dither';
import { useUi, type Ambient as AmbientMode } from '../store/ui';

const DitherBackdrop = lazy(() => import('./DitherBackdrop').then((m) => ({ default: m.DitherBackdrop })));

const ditherColour = (a: AmbientMode): DitherColour | null =>
  a === 'dither' ? 'red' : a.startsWith('dither-') ? (a.slice(7) as DitherColour) : null;

/** Ambient background: stacked fixed gradient layers where only opacity is animated (compositor only),
    or — for the Dither modes — a low-res WebGL canvas (mounted only while a Dither mode is active). */
export function Ambient() {
  const ambient = useUi((s) => s.ambient);
  // Now Playing draws its own Dither backdrop over the whole window; don't run two at once
  const npOpen = useUi((s) => s.nowPlayingOpen);
  const colour = ditherColour(ambient);
  return (
    <div className="ambient" aria-hidden="true">
      {colour ? (
        npOpen ? null : <Suspense fallback={null}><DitherBackdrop colour={colour} /></Suspense>
      ) : (
        <>
          <i className="ambient__l ambient__l--blue" />
          <i className="ambient__l ambient__l--purple" />
          <i className="ambient__l ambient__l--slate" />
          <i className="ambient__l ambient__l--green" />
        </>
      )}
    </div>
  );
}
