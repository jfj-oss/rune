import { Heart, ListMusic, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { coverSrc } from '../api';
import { tileGradient } from '../lib/color';
import { isLiked } from '../hooks/usePlaylistPlay';
import { WAVE_COVER_IDS } from '../lib/waveCover';
import { WaveCover } from './WaveCover';

interface Props {
  id: string;
  name: string;
  imageUrl?: string;
  /** rune playlists: up to four album ids for a 2x2 mosaic */
  albumIds?: string[];
  smart?: boolean;
  iconSize?: number;
}

/** Playlist artwork: Spotify's image, a 2x2 album mosaic for rune playlists, otherwise a gradient tile (heart for Liked Songs). */
export function PlaylistCover({ id, name, imageUrl, albumIds, smart, iconSize = 40 }: Props) {
  const [state, setState] = useState<'loading' | 'ok' | 'err'>('loading');
  if (WAVE_COVER_IDS.has(id)) {
    return (
      <div className="cover plcover plcover--wave" aria-label={name} role="img">
        <WaveCover seed={[...id].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 997, 0) % 7} />
      </div>
    );
  }
  const liked = isLiked(id);
  const showImg = !!imageUrl && state !== 'err' && !liked;
  const mosaic = !showImg && !liked && albumIds && albumIds.length > 0 ? albumIds : null;
  return (
    <div className={`cover plcover${liked ? ' plcover--liked' : ''}${mosaic ? ' plcover--mosaic' : ''}`} data-state={state} style={liked ? undefined : { background: tileGradient(id) }} aria-label={name} role="img">
      {showImg ? (
        <img src={imageUrl} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onLoad={() => setState('ok')} onError={() => setState('err')} />
      ) : mosaic ? (
        <div className={`plmosaic plmosaic--${mosaic.length === 1 ? 1 : 4}`}>
          {(mosaic.length === 1 ? mosaic : [0, 1, 2, 3].map((i) => mosaic[i % mosaic.length]!)).map((a, i) => (
            <img key={`${a}-${i}`} src={coverSrc({ id: a }, 200)} alt="" loading="lazy" decoding="async" draggable={false} />
          ))}
        </div>
      ) : liked ? (
        <Heart size={iconSize} fill="currentColor" />
      ) : smart ? (
        <Sparkles size={iconSize} />
      ) : (
        <ListMusic size={iconSize} />
      )}
    </div>
  );
}
