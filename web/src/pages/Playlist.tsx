import type { PlaylistDetail } from '@liner/shared';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Disc3, ListEnd, ListStart, MoreHorizontal, Play, Plus, Shuffle, User } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { Eq } from '../components/Eq';
import { Cover } from '../components/Cover';
import { MobileBack } from '../components/MobileBack';
import { MenuItem, Popover } from '../components/Popover';
import { PlaylistCover } from '../components/PlaylistCover';
import { Empty } from '../components/Rows';
import { useScrollRoot } from '../hooks/scrollRoot';
import { isLiked, playlistItem, playlistItems, playlistUri, usePlaylistPlay } from '../hooks/usePlaylistPlay';
import { encId, formatDuration, formatTotalLength, plural } from '../lib/format';
import { currentItem, usePlayer } from '../store/player';

export default function PlaylistPage() {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
  if (q.isError) return <div className="page"><Empty title="Playlist not found">It may have been removed from Spotify, or hasn’t synced yet.</Empty></div>;
  if (!q.data) return <PlaylistSkeleton />;
  return <PlaylistView d={q.data} />;
}

function PlaylistSkeleton() {
  return (
    <div className="page page--album">
      <div className="ahero"><div className="ahero__inner">
        <div className="ahero__cover"><div className="cover shimmer" /></div>
        <div className="ahero__txt"><div className="skel skel--line shimmer" style={{ width: 80 }} /><div className="skel skel--title shimmer" /><div className="skel skel--line shimmer" style={{ width: '50%' }} /></div>
      </div></div>
    </div>
  );
}

function PlaylistView({ d }: { d: PlaylistDetail }) {
  const { play, enqueue } = usePlaylistPlay();
  const items = useMemo(() => playlistItems(d), [d]);
  const totalMs = useMemo(() => d.tracks.reduce((n, t) => n + t.durationMs, 0), [d]);
  const liked = isLiked(d.id);
  const bgSrc = d.imageUrl ?? (d.tracks[0] ? coverSrc(d.tracks[0].album, 200) : undefined);

  return (
    <div className="page page--album page--playlist">
      <section className="ahero">
        <div className={`ahero__bg${liked ? ' ahero__bg--liked' : ''}`} aria-hidden>
          {!liked && bgSrc && <img src={bgSrc} alt="" referrerPolicy="no-referrer" />}
          <div className="ahero__wash" />
        </div>
        <MobileBack />
        <div className="ahero__inner">
          <div className="ahero__cover"><PlaylistCover id={d.id} name={d.name} imageUrl={d.imageUrl} iconSize={96} /></div>
          <div className="ahero__txt">
            <span className="eyebrow ahero__kind">Playlist</span>
            <h1 className="ahero__title">{d.name}</h1>
            {d.description && <p className="ahero__desc">{d.description}</p>}
            <p className="ahero__meta">
              {d.owner && <><span className="link--strong">{d.owner}</span><span className="dot">·</span></>}
              <span>{plural(d.trackCount || d.tracks.length, 'track')}, {formatTotalLength(totalMs)}</span>
            </p>
            <div className="ahero__tags"><span className="badge badge--spotify"><i className="badge__dot" />Spotify</span></div>
            <div className="ahero__actions">
              <button className="btn btn--primary" onClick={() => void play(d.id)}><Play size={18} fill="currentColor" /> Play</button>
              <button className="btn" onClick={() => void play(d.id, { shuffle: true })}><Shuffle size={17} /> Shuffle</button>
              <button className="btn" onClick={() => void enqueue(d.id)}><Plus size={18} /> Queue</button>
            </div>
          </div>
        </div>
      </section>
      <div className="abody">
        {d.tracks.length === 0 ? <Empty title="No tracks yet">This playlist is empty, or hasn’t finished syncing.</Empty> : <PlaylistTracks d={d} items={items} />}
      </div>
    </div>
  );
}

const ROW = 56;

function PlaylistTracks({ d, items }: { d: PlaylistDetail; items: ReturnType<typeof playlistItems> }) {
  const root = useScrollRoot();
  const wrap = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const nav = useNavigate();
  const state = usePlayer((s) => s.state);
  const playItems = usePlayer((s) => s.playItems);
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const cur = currentItem(state);
  const ctx = playlistUri(d.id);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const r = root.current;
      if (r) setOffset(el.getBoundingClientRect().top - r.getBoundingClientRect().top + r.scrollTop);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, [root]);

  const v = useVirtualizer({ count: d.tracks.length, getScrollElement: () => root.current, estimateSize: () => ROW, overscan: 10, scrollMargin: offset });
  useEffect(() => { v.measure(); }, [offset, v]);

  return (
    <div className="ptracks" role="table" aria-label="Tracks">
      <div className="prow prow--head" role="row">
        <span>#</span><span>Title</span><span className="prow__albumcol">Album</span><span className="prow__dur">Time</span><span />
      </div>
      <div ref={wrap} className="vgrid" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((row) => {
          const t = d.tracks[row.index]!;
          const playing = cur?.track.id === t.id && state.queue[state.index]?.track.id === t.id;
          const go = () => void playItems(items, row.index, { context: ctx });
          return (
            <div
              key={row.key}
              className={`prow${playing ? ' is-playing' : ''}`}
              role="row"
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start - v.options.scrollMargin}px)` }}
              onDoubleClick={go}
            >
              <button className="trow__num prow__num" aria-label={`Play ${t.title}`} onClick={go}>
                <span className="trow__n">{playing ? <Eq playing={state.status === 'playing'} /> : row.index + 1}</span>
                <Play size={14} fill="currentColor" className="trow__p" />
              </button>
              <div className="prow__main">
                <span className="prow__art"><Cover album={t.album} sizes="40px" /></span>
                <div className="prow__txt">
                  <span className="prow__name" title={t.title}>{t.title}</span>
                  <span className="prow__artist">{t.artists.map((a, k) => <span key={a.id}>{k > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>)}</span>
                </div>
              </div>
              <Link to={`/album/${encId(t.album.id)}`} className="link prow__albumcol prow__album" title={t.album.title}>{t.album.title}</Link>
              <span className="prow__dur">{formatDuration(t.durationMs)}</span>
              <Popover
                className="trow__menu"
                placement="bottom-end"
                trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${t.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
              >
                {(close) => (
                  <div role="menu" className="menu">
                    <MenuItem icon={<ListStart size={16} />} onClick={() => { close(); void enqueueItems([playlistItem(t)], true); }}>Play next</MenuItem>
                    <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void enqueueItems([playlistItem(t)]); }}>Add to queue</MenuItem>
                    <MenuItem icon={<Disc3 size={16} />} onClick={() => { close(); nav(`/album/${encId(t.album.id)}`); }}>Go to album</MenuItem>
                    {t.artists[0] && <MenuItem icon={<User size={16} />} onClick={() => { close(); nav(`/artist/${encId(t.artists[0]!.id)}`); }}>Go to artist</MenuItem>}
                  </div>
                )}
              </Popover>
            </div>
          );
        })}
      </div>
    </div>
  );
}
