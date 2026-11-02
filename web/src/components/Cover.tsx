import { useState } from 'react';
import { coverSrc } from '../api';
import { tileGradient } from '../lib/color';
import { initials } from '../lib/format';

interface Props {
  album: { id: string; title?: string; coverUrl?: string };
  size?: 200 | 600 | 'full';
  sizes?: string;
  className?: string;
  eager?: boolean;
  alt?: string;
  /** Use this image instead of the album cover route. `null` = never request one. */
  src?: string | null;
}

/** Square, never cropped. Shows an initials tile until (or unless) the image loads. */
export function Cover({ album, size = 200, sizes, className = '', eager, alt = '', src: override }: Props) {
  const [state, setState] = useState<'loading' | 'ok' | 'err'>('loading');
  const src = override === undefined ? coverSrc(album, size) : override;
  const external = !!src && src.startsWith('http');
  const srcSet = override === undefined && size === 200 && !external ? `${coverSrc(album, 200)} 200w, ${coverSrc(album, 600)} 600w` : undefined;
  return (
    <div className={`cover ${className}`} style={{ background: tileGradient(album.id) }} data-state={state}>
      <span className="cover__ini" aria-hidden>{initials(album.title ?? '?')}</span>
      {state !== 'err' && src && (
        <img
          src={src}
          srcSet={srcSet}
          sizes={srcSet ? (sizes ?? '200px') : undefined}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => setState('ok')}
          onError={() => setState('err')}
        />
      )}
    </div>
  );
}
