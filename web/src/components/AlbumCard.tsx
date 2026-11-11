import type { AlbumSummary } from '@liner/shared';
import { Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { encId } from '../lib/format';
import { usePlay } from '../hooks/usePlay';
import { Cover } from './Cover';
import { PinMark } from './Pin';

export function FormatBadge({ format, source }: { format?: string; source: string }) {
  const spotify = source === 'spotify';
  const text = spotify ? 'Spotify' : format;
  if (!text) return null;
  return (
    <span className={`badge${spotify ? ' badge--spotify' : ''}`}>
      {spotify && <i className="badge__dot" />}
      {text}
    </span>
  );
}

export function AlbumCard({ album, width, eager }: { album: AlbumSummary; width?: number; eager?: boolean }) {
  const { playAlbum } = usePlay();
  return (
    <article className="card" style={width ? { width } : undefined}>
      <div className="card__art">
        <Link to={`/album/${encId(album.id)}`} className="card__artlink" aria-label={`${album.title} by ${album.artist.name}`} tabIndex={-1}>
          <Cover album={album} sizes={`${width ?? 180}px`} eager={eager} />
        </Link>
        <span className="card__badge"><FormatBadge format={album.format} source={album.source} /></span>
        {album.pinned && <PinMark className="card__pin" />}
        <button className="card__play" aria-label={`Play ${album.title}`} onClick={() => void playAlbum(album.id)}>
          <Play size={18} fill="currentColor" />
        </button>
      </div>
      <Link to={`/album/${encId(album.id)}`} className="card__title" title={album.title}>{album.title}</Link>
      <div className="card__sub">
        <Link to={`/artist/${encId(album.artist.id)}`} className="link">{album.artist.name}</Link>
        {album.year ? <span className="card__year"> · {album.year}</span> : null}
      </div>
    </article>
  );
}

export function CardSkeleton({ width }: { width?: number }) {
  return (
    <div className="card card--skeleton" style={width ? { width } : undefined}>
      <div className="card__art"><div className="cover shimmer" /></div>
      <div className="skel skel--line" />
      <div className="skel skel--line skel--short" />
    </div>
  );
}
