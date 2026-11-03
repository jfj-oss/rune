import { lazy, Suspense } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { paletteFromColour, type DitherColour } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi, type Ambient as AmbientMode } from '../store/ui';
import type { BackdropColour } from './DitherBackdrop';

const DitherBackdrop = lazy(() => import('./DitherBackdrop').then((m) => ({ default: m.DitherBackdrop })));

const ditherColour = (a: AmbientMode): DitherColour | 'album' | null =>
  a === 'dither' ? 'red' : a === 'dither-album' ? 'album' : a.startsWith('dither-') ? (a.slice(7) as DitherColour) : null;

/** "Dither · Album": the dots take the colour of the playing album's cover (purple when nothing plays). */
function AlbumDither() {
  const album = usePlayer((s) => currentItem(s.state)?.album);
  const tint = useCoverColor(album);
  const page = useUi((s) => s.pagePalette);
  const colour: BackdropColour = page ?? (album && paletteFromColour(tint)) ?? 'purple';
  return <DitherBackdrop colour={colour} />;
}

/** Ambient background: stacked fixed gradient layers where only opacity is animated (compositor only),
    or — for the Dither modes — a low-res WebGL canvas (mounted only while a Dither mode is active). */
export function Ambient() {
  const ambient = useUi((s) => s.ambient);
  // Now Playing draws its own Dither backdrop over the whole window; don't run two at once
  const npOpen = useUi((s) => s.nowPlayingOpen);
  const colour = ditherColour(ambient);
  // an open album page tints every Dither mode with its own cover colour (the dots blend over there and back)
  const page = useUi((s) => s.pagePalette);
  return (
    <div className="ambient" aria-hidden="true">
      {colour ? (
        npOpen ? null : (
          <Suspense fallback={null}>{colour === 'album' ? <AlbumDither /> : <DitherBackdrop colour={page ?? colour} />}</Suspense>
        )
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
