import type { PlaylistSummary } from '@liner/shared';
import { useQuery } from '@tanstack/react-query';
import { ListMusic, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { LibraryTabs } from './Albums';
import { PlaylistCover } from '../components/PlaylistCover';
import { Empty } from '../components/Rows';
import { useIsDesktop } from '../hooks/useMedia';
import { isLiked, usePlaylistPlay } from '../hooks/usePlaylistPlay';
import { encId, plural } from '../lib/format';
import { useSpotify } from '../store/spotify';

function PlaylistCard({ p }: { p: PlaylistSummary }) {
  const { play } = usePlaylistPlay();
  const href = `/playlist/${encId(p.id)}`;
  return (
    <article className="card plcard">
      <div className="card__art">
        <Link to={href} className="card__artlink" aria-label={p.name} tabIndex={-1}><PlaylistCover id={p.id} name={p.name} imageUrl={p.imageUrl} /></Link>
        <button className="card__play" aria-label={`Play ${p.name}`} onClick={() => void play(p.id)}><Play size={18} fill="currentColor" /></button>
      </div>
      <Link to={href} className="card__title" title={p.name}>{p.name}</Link>
      <div className="card__sub">{p.owner ? `${p.owner} · ` : ''}{plural(p.trackCount, 'track')}</div>
    </article>
  );
}

export default function Playlists() {
  const desktop = useIsDesktop();
  const connected = useSpotify((s) => s.connected);
  const loaded = useSpotify((s) => s.loaded);
  const q = useQuery({ queryKey: ['playlists'], queryFn: () => api.playlists() });
  const list = [...(q.data ?? [])].sort((a, b) => Number(isLiked(b.id)) - Number(isLiked(a.id)));

  return (
    <div className="page page--playlists">
      {!desktop && <LibraryTabs active="playlists" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Playlists</h1>
          <p className="pagehead__sub">{q.isLoading ? ' ' : plural(list.length, 'playlist')}</p>
        </div>
      </header>
      {q.isError ? (
        <Empty title="Could not load playlists" icon={<ListMusic size={28} />}>Is the rune server running?</Empty>
      ) : q.isLoading ? (
        <div className="grid grid--lib">{Array.from({ length: 12 }, (_, i) => <div key={i} className="card card--skeleton"><div className="card__art"><div className="cover shimmer" /></div><div className="skel skel--line" /><div className="skel skel--line skel--short" /></div>)}</div>
      ) : list.length === 0 ? (
        loaded && !connected ? (
          <Empty title="Spotify isn’t connected" icon={<ListMusic size={28} />}>
            Connect your account to see your playlists and Liked Songs.<br /><br />
            <a className="btn btn--primary" href="/api/spotify/login">Connect Spotify</a>
          </Empty>
        ) : (
          <Empty title="No playlists yet" icon={<ListMusic size={28} />}>Your Spotify library is still syncing — check back in a minute.</Empty>
        )
      ) : (
        <div className="grid grid--lib">{list.map((p) => <PlaylistCard key={p.id} p={p} />)}</div>
      )}
    </div>
  );
}
