import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Disc3, ListEnd, ListStart, MoreHorizontal, Play, Radio, Search, User, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { browseApi } from '../browseApi';
import { Cover } from '../components/Cover';
import { Eq } from '../components/Eq';
import { AddToPlaylistItem } from '../components/AddToPlaylist';
import { MenuItem, Popover } from '../components/Popover';
import { Empty } from '../components/Rows';
import { useScrollRoot } from '../hooks/scrollRoot';
import { useIsDesktop } from '../hooks/useMedia';
import { encId, formatDuration, plural } from '../lib/format';
import { startRadio } from '../lib/radio';
import type { BrowseTrack, PlayItem, TrackSort } from '../lib/types';
import { currentItem, usePlayer } from '../store/player';
import { LibraryTabs } from './Albums';

const PAGE = 200;
/** How many following rows a click queues (so "next" keeps going in the list's order). */
const QUEUE_AHEAD = 300;
const SORTS: { id: TrackSort; label: string }[] = [
  { id: 'title', label: 'Title' }, { id: 'artist', label: 'Artist' }, { id: 'album', label: 'Album' },
  { id: 'duration', label: 'Duration' }, { id: 'added', label: 'Date added' },
];
const isSort = (v: string | null): v is TrackSort => SORTS.some((s) => s.id === v);

const toItem = (t: BrowseTrack): PlayItem => {
  const { album, ...track } = t;
  return { track, album };
};

export default function Tracks() {
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const sort: TrackSort = isSort(params.get('sort')) ? (params.get('sort') as TrackSort) : 'title';
  const defaultDir = sort === 'added' ? 'desc' : 'asc';
  const dir = params.get('dir') === 'desc' ? 'desc' : params.get('dir') === 'asc' ? 'asc' : defaultDir;
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);

  const patch = useCallback((p: Record<string, string | undefined>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(p)) if (v) next.set(k, v); else next.delete(k);
      return next;
    }, { replace: true });
  }, [setParams]);

  // debounce the filter box into the URL
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => patch({ q: text.trim() || undefined }), 250);
    return () => clearTimeout(t);
  }, [text, q, patch]);

  const setSort = (s: TrackSort) => {
    if (s === sort) patch({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else patch({ sort: s === 'title' ? undefined : s, dir: undefined });
  };

  const query = { q: q || undefined, sort, dir } as const;
  const res = useInfiniteQuery({
    queryKey: ['tracks', query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => browseApi.tracks({ ...query, offset: pageParam, limit: PAGE }),
    getNextPageParam: (last, all) => { const n = all.reduce((s, p) => s + p.items.length, 0); return n < last.total ? n : undefined; },
  });
  const items = useMemo(() => res.data?.pages.flatMap((p) => p.items) ?? [], [res.data]);
  const total = res.data?.pages[0]?.total ?? 0;
  const needMore = useCallback(() => { if (res.hasNextPage && !res.isFetchingNextPage) void res.fetchNextPage(); }, [res]);

  return (
    <div className="page page--tracks">
      {!desktop && <LibraryTabs active="tracks" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Tracks</h1>
          <p className="pagehead__sub">{res.isLoading ? ' ' : q ? `${plural(total, 'track')} matching “${q}”` : plural(total, 'track')}</p>
        </div>
      </header>
      <div className="toolbar">
        <label className="filterbox">
          <Search size={15} aria-hidden />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by title, artist or album" aria-label="Filter tracks" />
          {text && <button type="button" className="btn-icon filterbox__x" aria-label="Clear filter" onClick={() => { setText(''); patch({ q: undefined }); }}><X size={14} /></button>}
        </label>
        <span className="toolbar__spacer" />
        <label className="select">
          <span>Sort</span>
          <select value={sort} onChange={(e) => patch({ sort: e.target.value === 'title' ? undefined : e.target.value, dir: undefined })} aria-label="Sort tracks">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <button className="btn-icon tk-dir" aria-label={dir === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'} onClick={() => patch({ dir: dir === 'asc' ? 'desc' : 'asc' })}>
          {dir === 'asc' ? <ArrowUp size={17} /> : <ArrowDown size={17} />}
        </button>
      </div>

      {res.isError ? (
        <Empty title="Could not load tracks">Is the rune server running?</Empty>
      ) : res.isLoading ? (
        <div className="tracklist">{Array.from({ length: 14 }, (_, i) => <div key={i} className="tk tk--skel"><div className="skel shimmer" style={{ width: 40, height: 40, borderRadius: 4 }} /><div className="skel skel--line shimmer" /></div>)}</div>
      ) : total === 0 ? (
        <Empty title="No tracks here">{q ? 'Nothing matches that filter.' : 'The library has no tracks yet.'}</Empty>
      ) : (
        <>
          {desktop && (
            <div className="tkhead" role="row">
              <span />
              <SortHead label="Title" id="title" sort={sort} dir={dir} onSort={setSort} />
              <SortHead label="Artist" id="artist" sort={sort} dir={dir} onSort={setSort} />
              <SortHead label="Album" id="album" sort={sort} dir={dir} onSort={setSort} />
              <SortHead label="Time" id="duration" sort={sort} dir={dir} onSort={setSort} right />
              <span />
            </div>
          )}
          <VirtualTracks items={items} total={total} desktop={desktop} onNeedMore={needMore} />
        </>
      )}
    </div>
  );
}

function SortHead({ label, id, sort, dir, onSort, right }: { label: string; id: TrackSort; sort: TrackSort; dir: 'asc' | 'desc'; onSort(s: TrackSort): void; right?: boolean }) {
  const on = sort === id;
  return (
    <button className={`tkhead__col${on ? ' is-active' : ''}${right ? ' tkhead__col--r' : ''}`} onClick={() => onSort(id)} aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {label}
      {on && (dir === 'asc' ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />)}
    </button>
  );
}

function VirtualTracks({ items, total, desktop, onNeedMore }: { items: BrowseTrack[]; total: number; desktop: boolean; onNeedMore(): void }) {
  const root = useScrollRoot();
  const wrap = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const rowH = desktop ? 56 : 62;

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
    return () => ro.disconnect();
  }, [root, desktop]);

  const v = useVirtualizer({ count: total, getScrollElement: () => root.current, estimateSize: () => rowH, overscan: 8, scrollMargin: offset });
  useEffect(() => { v.measure(); }, [rowH, v]);
  const vis = v.getVirtualItems();
  const last = vis[vis.length - 1]?.index ?? 0;
  useEffect(() => { if (last + 40 >= items.length) onNeedMore(); }, [last, items.length, onNeedMore]);

  const playItems = usePlayer((s) => s.playItems);
  const play = useCallback((i: number) => { void playItems(items.slice(i, i + QUEUE_AHEAD).map(toItem), 0); }, [items, playItems]);
  const state = usePlayer((s) => s.state);
  const cur = currentItem(state);

  return (
    <div ref={wrap} className="tracklist" role="table" aria-label="Tracks" aria-rowcount={total} style={{ height: v.getTotalSize() }}>
      {vis.map((row) => {
        const t = items[row.index];
        return (
          <div key={row.key} className="tklayer" style={{ height: row.size, transform: `translateY(${row.start - v.options.scrollMargin}px)` }}>
            {t ? <TrackRow t={t} playing={cur?.track.id === t.id} isPlaying={state.status === 'playing'} desktop={desktop} onPlay={() => play(row.index)} /> : <div className="tk tk--skel"><div className="skel shimmer" style={{ width: 40, height: 40, borderRadius: 4 }} /><div className="skel skel--line shimmer" /></div>}
          </div>
        );
      })}
    </div>
  );
}

function TrackRow({ t, playing, isPlaying, desktop, onPlay }: { t: BrowseTrack; playing: boolean; isPlaying: boolean; desktop: boolean; onPlay(): void }) {
  const nav = useNavigate();
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const artists = t.artists.map((a, k) => <span key={a.id}>{k > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link" onClick={stop}>{a.name}</Link></span>);
  const albumLink = <Link to={`/album/${encId(t.album.id)}`} className="link" onClick={stop}>{t.album.title}</Link>;
  return (
    <div className={`tk${playing ? ' is-playing' : ''}`} role="row" onClick={onPlay}>
      <button className="tk__art" aria-label={`Play ${t.title}`} onClick={(e) => { stop(e); onPlay(); }}>
        <Cover album={{ id: t.album.id, title: t.album.title }} sizes="40px" />
        <span className="tk__ov">{playing ? <Eq playing={isPlaying} /> : <Play size={16} fill="currentColor" />}</span>
      </button>
      <div className="tk__title">
        <span className="tk__name" title={t.title}>{t.title}</span>
        {!desktop && <span className="tk__sub">{artists} · {albumLink}</span>}
      </div>
      {desktop && <span className="tk__col">{artists}</span>}
      {desktop && <span className="tk__col">{albumLink}</span>}
      <span className="tk__dur">{formatDuration(t.durationMs)}</span>
      <span onClick={stop} className="tk__menu">
        <Popover
          placement="bottom-end"
          trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${t.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
        >
          {(close) => (
            <div role="menu" className="menu">
              <MenuItem icon={<ListStart size={16} />} onClick={() => { close(); void enqueueItems([toItem(t)], true); }}>Play next</MenuItem>
              <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void enqueueItems([toItem(t)]); }}>Add to queue</MenuItem>
              <AddToPlaylistItem close={close} target={{ what: t.title, resolve: () => [toItem(t)] }} />
              {t.source === 'local' && <MenuItem icon={<Radio size={16} />} onClick={() => { close(); void startRadio('track', t.id); }}>Start radio</MenuItem>}
              <MenuItem icon={<Disc3 size={16} />} onClick={() => { close(); nav(`/album/${encId(t.album.id)}`); }}>Go to album</MenuItem>
              {t.artists[0] && <MenuItem icon={<User size={16} />} onClick={() => { close(); nav(`/artist/${encId(t.artists[0]!.id)}`); }}>Go to artist</MenuItem>}
            </div>
          )}
        </Popover>
      </span>
    </div>
  );
}
