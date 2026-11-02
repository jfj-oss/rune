import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal, Play, Search as SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AlbumCard, FormatBadge } from '../components/AlbumCard';
import { Avatar } from '../components/album/Credits';
import { Cover } from '../components/Cover';
import { Popover } from '../components/Popover';
import { Empty, HScroll, SectionHead } from '../components/Rows';
import { TrackMenuItems, trackMenuHandler } from '../components/TrackMenu';
import { useIsDesktop } from '../hooks/useMedia';
import { usePlay } from '../hooks/usePlay';
import { encId, formatDuration } from '../lib/format';
import type { PlayItem } from '../lib/types';
import { useSearchNav, type NavItem } from '../store/searchNav';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const desktop = useIsDesktop();
  const nav = useNavigate();
  const { playAlbum, getAlbum } = usePlay();
  const [local, setLocal] = useState(q);
  useEffect(() => setLocal(q), [q]);
  // mobile has its own box; debounce 200 ms
  useEffect(() => {
    if (desktop || local.trim() === q) return;
    const t = setTimeout(() => setParams(local.trim() ? { q: local.trim() } : {}, { replace: true }), 200);
    return () => clearTimeout(t);
  }, [local, q, desktop, setParams]);

  const res = useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: q.length > 0, placeholderData: (p) => p });
  const data = res.data;
  const albums = data?.albums ?? [];
  const artists = data?.artists ?? [];
  // local hits first, then Spotify catalogue hits (the server appends those; don't let 8 local ones push them out)
  const tracks = useMemo(() => {
    const all = data?.tracks ?? [];
    return [...all.filter((t) => t.source !== 'spotify').slice(0, 8), ...all.filter((t) => t.source === 'spotify').slice(0, 6)];
  }, [data]);

  const top = useMemo(() => {
    const lq = q.toLowerCase();
    const a = artists.find((x) => x.name.toLowerCase().startsWith(lq));
    if (a) return { kind: 'artist' as const, artist: a };
    const al = albums[0];
    if (al) return { kind: 'album' as const, album: al };
    const ar = artists[0];
    return ar ? { kind: 'artist' as const, artist: ar } : null;
  }, [q, albums, artists]);

  const playTrack = async (albumId: string, trackId: string) => {
    const a = await getAlbum(albumId);
    const idx = a.tracks.findIndex((t) => t.id === trackId);
    await playAlbum(albumId, { startIndex: Math.max(0, idx) });
  };

  // keyboard nav registry (desktop ↑↓ / Enter handled by the top bar)
  const active = useSearchNav((s) => s.active);
  const setItems = useSearchNav((s) => s.set);
  const items = useMemo<(NavItem & { id: string })[]>(() => {
    const out: (NavItem & { id: string })[] = [];
    if (top) out.push({ id: 'top', key: 'top', activate: () => nav(top.kind === 'artist' ? `/artist/${encId(top.artist.id)}` : `/album/${encId(top.album.id)}`) });
    albums.forEach((a) => out.push({ id: `al:${a.id}`, key: a.id, activate: () => nav(`/album/${encId(a.id)}`) }));
    artists.forEach((a) => out.push({ id: `ar:${a.id}`, key: a.id, activate: () => nav(`/artist/${encId(a.id)}`) }));
    tracks.forEach((t) => out.push({ id: `tr:${t.id}`, key: t.id, activate: () => void playTrack(t.albumId, t.id) }));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, albums, artists, tracks]);
  useEffect(() => { setItems(items); return () => useSearchNav.getState().reset(); }, [items, setItems]);
  const activeId = items[active]?.id;
  useEffect(() => { document.querySelector('[data-nav-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  const nv = (id: string) => ({ 'data-nav-active': activeId === id ? 'true' : undefined });

  const albumTitle = (id: string) => albums.find((a) => a.id === id)?.title ?? '';
  const empty = q && data && !albums.length && !artists.length && !tracks.length;

  return (
    <div className="page page--search">
      {!desktop && (
        <label className="search search--page">
          <SearchIcon size={18} />
          <input autoFocus={!q} type="search" value={local} placeholder="Search albums, artists, tracks" aria-label="Search" onChange={(e) => setLocal(e.target.value)} />
        </label>
      )}
      {!q ? (
        <Empty title="Search your library" icon={<SearchIcon size={28} />}>Albums, artists and tracks — local and Spotify together.</Empty>
      ) : empty ? (
        <Empty title={`No results for “${q}”`}>Try a different spelling or fewer words.</Empty>
      ) : (
        <>
          {top && (
            <section className="section">
              <SectionHead title="Top result" />
              <div className="topres" {...nv('top')}>
                {top.kind === 'artist' ? (
                  <>
                    <Link to={`/artist/${encId(top.artist.id)}`} className="topres__art topres__art--round"><Avatar name={top.artist.name} id={top.artist.id} size={112} /></Link>
                    <div className="topres__txt"><span className="eyebrow">Artist</span><Link to={`/artist/${encId(top.artist.id)}`} className="topres__name">{top.artist.name}</Link></div>
                  </>
                ) : (
                  <>
                    <Link to={`/album/${encId(top.album.id)}`} className="topres__art"><Cover album={top.album} size={200} sizes="112px" /></Link>
                    <div className="topres__txt">
                      <span className="eyebrow">Album</span>
                      <Link to={`/album/${encId(top.album.id)}`} className="topres__name">{top.album.title}</Link>
                      <span className="topres__sub"><Link to={`/artist/${encId(top.album.artist.id)}`} className="link">{top.album.artist.name}</Link>{top.album.year ? ` · ${top.album.year}` : ''} <FormatBadge format={top.album.format} source={top.album.source} /></span>
                    </div>
                    <button className="btn btn--primary topres__play" onClick={() => void playAlbum(top.album.id)}><Play size={18} fill="currentColor" /> Play</button>
                  </>
                )}
              </div>
            </section>
          )}

          {albums.length > 0 && (
            <section className="section">
              <SectionHead title="Albums" />
              <HScroll>{albums.map((a) => <div key={a.id} className="navwrap" {...nv(`al:${a.id}`)}><AlbumCard album={a} width={170} /></div>)}</HScroll>
            </section>
          )}

          {artists.length > 0 && (
            <section className="section">
              <SectionHead title="Artists" />
              <div className="artrow">
                {artists.map((a) => (
                  <Link key={a.id} to={`/artist/${encId(a.id)}`} className="artcard artcard--sm" {...nv(`ar:${a.id}`)}>
                    <Avatar name={a.name} id={a.id} size={96} /><b>{a.name}</b>{a.id.startsWith('sp:') && <span className="artcard__src"><FormatBadge source="spotify" /></span>}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {tracks.length > 0 && (
            <section className="section">
              <SectionHead title="Tracks" />
              <ul className="tlist">
                {tracks.map((t) => {
                  const item: PlayItem = { track: t, album: { id: t.albumId, title: albumTitle(t.albumId) } };
                  return (
                    <li key={t.id} className="tlist__row" {...nv(`tr:${t.id}`)} onContextMenu={trackMenuHandler(item)}>
                      <button className="tlist__art" aria-label={`Play ${t.title}`} onClick={() => void playTrack(t.albumId, t.id)}>
                        <Cover album={{ id: t.albumId, title: albumTitle(t.albumId) }} sizes="44px" />
                        <span className="tlist__play"><Play size={16} fill="currentColor" /></span>
                      </button>
                      <div className="tlist__txt">
                        <b>{t.title}</b>
                        <span>{t.artists.map((a, i) => <span key={a.id}>{i > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>)}</span>
                      </div>
                      <FormatBadge source={t.source} format={t.format === 'flac' ? 'FLAC' : t.format === 'mp3' ? 'MP3' : undefined} />
                      <span className="tlist__dur">{formatDuration(t.durationMs)}</span>
                      <Popover
                        className="tlist__menu"
                        placement="bottom-end"
                        trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${t.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
                      >
                        {(close) => <TrackMenuItems item={item} close={close} />}
                      </Popover>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
