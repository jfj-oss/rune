import { Heart, ListMusic } from 'lucide-react';
import { useState } from 'react';
import { tileGradient } from '../lib/color';
import { isLiked } from '../hooks/usePlaylistPlay';

/** Playlist artwork: Spotify's image when there is one, otherwise a gradient tile (heart for Liked Songs). */
export function PlaylistCover({ id, name, imageUrl, iconSize = 40 }: { id: string; name: string; imageUrl?: string; iconSize?: number }) {
  const [state, setState] = useState<'loading' | 'ok' | 'err'>('loading');
  const liked = isLiked(id);
  const showImg = !!imageUrl && state !== 'err' && !liked;
  return (
    <div className={`cover plcover${liked ? ' plcover--liked' : ''}`} data-state={state} style={liked ? undefined : { background: tileGradient(id) }} aria-label={name} role="img">
      {showImg ? (
        <img src={imageUrl} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onLoad={() => setState('ok')} onError={() => setState('err')} />
      ) : liked ? (
        <Heart size={iconSize} fill="currentColor" />
      ) : (
        <ListMusic size={iconSize} />
      )}
    </div>
  );
}
