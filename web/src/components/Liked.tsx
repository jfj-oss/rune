import type { Track } from '@liner/shared';
import { Heart } from 'lucide-react';
import { useLiked } from '../hooks/useLiked';
import { MenuItem } from './Popover';

/**
 * The heart: only Spotify songs can live in Liked Songs (local files cannot), so
 * anything else renders nothing at all rather than a disabled control.
 */
export function LikedHeart({ track, size = 16 }: { track: Track; size?: number }) {
  if (track.source !== 'spotify') return null;
  return <LikedHeartButton trackId={track.id} size={size} />;
}

function LikedHeartButton({ trackId, size }: { trackId: string; size: number }) {
  const { liked, loading, pending, toggle } = useLiked(trackId);
  const label = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  return (
    <button
      className={`btn-icon likebtn${liked ? ' is-on' : ''}`}
      aria-label={label}
      aria-pressed={liked}
      title={label}
      disabled={loading || pending}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggle(); }}
    >
      <Heart size={size} fill={liked ? 'currentColor' : 'none'} />
    </button>
  );
}

/** The same toggle as an item in the shared track menu. */
export function LikedMenuItem({ track, close }: { track: Track; close(): void }) {
  if (track.source !== 'spotify') return null;
  return <LikedMenuButton trackId={track.id} close={close} />;
}

function LikedMenuButton({ trackId, close }: { trackId: string; close(): void }) {
  const { liked, toggle } = useLiked(trackId);
  return (
    <MenuItem
      icon={<Heart size={16} fill={liked ? 'currentColor' : 'none'} />}
      onClick={() => { close(); void toggle(); }}
    >
      {liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
    </MenuItem>
  );
}
