import { lazy, Suspense } from 'react';
import { useCoverColor } from '../hooks/useCoverColor';
import { paletteFromColour, type DitherColour } from '../lib/dither';
import { currentItem, usePlayer } from '../store/player';
import { useUi, type Ambient as AmbientMode } from '../store/ui';
import type { BackdropColour } from './DitherBackdrop';

const DitherBackdrop = lazy(() => import('./DitherBackdrop').then((m) => ({ default: m.DitherBackdrop })));

const ditherColour = (a: AmbientMode): DitherColour | 'album' | 'custom' | null =>
  a === 'dither' ? 'red' : a === 'dither-album' ? 'album' : a === 'dither-custom' ? 'custom' : a.startsWith('dither-') ? (a.slice(7) as DitherColour) : null;

const rgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** "Dither · Custom": the two colours from Settings (base dots, highlights), whatever page is open. */
function CustomDither() {
  const d = useUi((s) => s.duotone);
  return <DitherBackdrop colour={{ mid: rgb(d.mid), light: rgb(d.light) }} main />;
}

/** "Dither · Album": the dots take the colour of the playing album's cover (purple when nothing plays). */
function AlbumDither() {
  const album = usePlayer((s) => currentItem(s.state)?.album);
  const tint = useCoverColor(album);
  const page = useUi((s) => s.pagePalette);
  const colour: BackdropColour = page ?? (album && paletteFromColour(tint)) ?? 'purple';
  return <DitherBackdrop colour={colour} main />;
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
          <Suspense fallback={null}>{colour === 'album' ? <AlbumDither /> : colour === 'custom' ? <CustomDither /> : <DitherBackdrop colour={page ?? colour} main />}</Suspense>
        )
      ) : null}
    </div>
  );
}
