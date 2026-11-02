import type { AlbumSummary } from '@liner/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LayoutGrid, List, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AlbumCard, CardSkeleton, FormatBadge } from '../components/AlbumCard';
import { Cover } from '../components/Cover';
import { Empty } from '../components/Rows';
import { useScrollRoot } from '../hooks/scrollRoot';
import { useIsDesktop } from '../hooks/useMedia';
import { encId, plural } from '../lib/format';
import type { AlbumQuery } from '../lib/types';
import { loadLocal, saveLocal } from '../store/ui';

const PAGE = 120;
const GAP = 22;
const MIN = 170;
const SORTS: { id: NonNullable<AlbumQuery['sort']>; label: string }[] = [
  { id: 'added', label: 'Date added' }, { id: 'artist', label: 'Artist' }, { id: 'title', label: 'Title' }, { id: 'year', label: 'Year' },
];

export function LibraryTabs({ active }: { active: 'albums' | 'artists' }) {
  return (
    <div className="seg seg--tabs" role="tablist">
      <Link role="tab" aria-selected={active === 'albums'} className={active === 'albums' ? 'is-active' : ''} to="/albums">Albums</Link>
      <Link role="tab" aria-selected={active === 'artists'} className={active === 'artists' ? 'is-active' : ''} to="/artists">Artists</Link>
    </div>
  );
}

export default function Albums() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const desktop = useIsDesktop();
  const sort = (params.get('sort') as AlbumQuery['sort']) ?? 'added';
  const source = (params.get('source') as 'local' | 'spotify' | null) ?? 'all';
  const genre = params.get('genre') ?? undefined;
  const label = params.get('label') ?? undefined;
  const year = params.get('year') ? Number(params.get('year')) : undefined;
  const [viewPref, setViewState] = useState<'grid' | 'list'>(() => loadLocal('rune.view', 'grid'));
  const view = desktop ? viewPref : 'grid';
  const setView = (v: 'grid' | 'list') => { setViewState(v); saveLocal('rune.view', v); };

  const set = (k: string, v?: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const query: AlbumQuery = { sort, source, genre, label, year };
  const q = useInfiniteQuery({
    queryKey: ['albums', 'library', query],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.albums({ ...query, offset: pageParam, limit: PAGE }),
    getNextPageParam: (last, all) => { const n = all.reduce((s, p) => s + p.items.length, 0); return n < last.total ? n : undefined; },
  });
  const items: AlbumSummary[] = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;

  const chips = [genre && ['genre', genre], label && ['label', label], year && ['year', String(year)]].filter(Boolean) as [string, string][];

  return (
    <div className="page page--albums">
      {!desktop && <LibraryTabs active="albums" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">{genre ?? label ?? (year ? String(year) : source === 'spotify' ? 'Spotify' : 'Albums')}</h1>
          <p className="pagehead__sub">{q.isLoading ? ' ' : plural(total, 'album')}</p>
        </div>
      </header>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="Source">
          {(['all', 'local', 'spotify'] as const).map((s) => (
            <button key={s} className={source === s ? 'is-active' : ''} aria-pressed={source === s} onClick={() => set('source', s === 'all' ? undefined : s)}>
              {s === 'all' ? 'All' : s === 'local' ? 'Local' : 'Spotify'}
            </button>
          ))}
        </div>
        {chips.map(([k, v]) => (
          <button key={k} className="chip chip--removable" onClick={() => set(k)} aria-label={`Remove ${k} filter`}>{k}: {v}<X size={12} /></button>
        ))}
        <span className="toolbar__spacer" />
        <label className="select">
          <span>Sort</span>
          <select value={sort} onChange={(e) => set('sort', e.target.value === 'added' ? undefined : e.target.value)} aria-label="Sort albums">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <div className="seg seg--icons" role="group" aria-label="View">
          <button className={view === 'grid' ? 'is-active' : ''} aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={16} /></button>
          <button className={view === 'list' ? 'is-active' : ''} aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={16} /></button>
        </div>
      </div>

      {q.isError ? (
        <Empty title="Could not load the library">Is the rune server running? Try <button className="link" onClick={() => nav(0)}>reloading</button>.</Empty>
      ) : q.isLoading ? (
        <div className="grid grid--lib">{Array.from({ length: 18 }, (_, i) => <CardSkeleton key={i} />)}</div>
      ) : total === 0 ? (
        <Empty title="No albums here">Nothing matches these filters.</Empty>
      ) : (
        <VirtualAlbums items={items} total={total} view={view} onNeedMore={() => { if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage(); }} />
      )}
    </div>
  );
}

function VirtualAlbums({ items, total, view, onNeedMore }: { items: AlbumSummary[]; total: number; view: 'grid' | 'list'; onNeedMore(): void }) {
  const root = useScrollRoot();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      const r = root.current;
      if (r) setOffset(el.getBoundingClientRect().top - r.getBoundingClientRect().top + r.scrollTop);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [root, view]);

  const gap = width < 520 ? 14 : GAP;
  const cols = view === 'list' ? 1 : Math.max(2, Math.floor((width + gap) / (MIN + gap)));
  const cardW = view === 'list' ? width : (width - gap * (cols - 1)) / cols;
  const rowH = view === 'list' ? 60 : cardW + 64 + gap;
  const rows = Math.ceil(total / cols);

  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => root.current,
    estimateSize: () => rowH,
    overscan: 4,
    scrollMargin: offset,
  });
  useEffect(() => { v.measure(); }, [rowH, v]);

  const vis = v.getVirtualItems();
  const lastRow = vis[vis.length - 1]?.index ?? 0;
  useEffect(() => { if ((lastRow + 3) * cols >= items.length) onNeedMore(); }, [lastRow, cols, items.length, onNeedMore]);

  return (
    <div ref={wrap} className="vgrid" style={{ height: v.getTotalSize() }}>
      {width > 0 && vis.map((row) => {
        const start = row.index * cols;
        const slice = Array.from({ length: cols }, (_, c) => items[start + c]).filter((_, c) => start + c < total);
        return (
          <div
            key={row.key}
            className={view === 'list' ? 'vgrid__list' : 'vgrid__row'}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start - v.options.scrollMargin}px)`, gap, gridTemplateColumns: view === 'grid' ? `repeat(${cols}, ${cardW}px)` : undefined }}
          >
            {slice.map((a, c) => a ? (view === 'grid' ? <AlbumCard key={a.id} album={a} width={cardW} eager={row.index < 2} /> : <ListRow key={a.id} album={a} />) : <CardSkeleton key={start + c} width={cardW} />)}
            {slice.length < cols && view === 'grid' && null}
          </div>
        );
      })}
    </div>
  );
}

function ListRow({ album }: { album: AlbumSummary }) {
  return (
    <div className="lrow">
      <Link to={`/album/${encId(album.id)}`} className="lrow__art" tabIndex={-1}><Cover album={album} sizes="44px" /></Link>
      <div className="lrow__main">
        <Link to={`/album/${encId(album.id)}`} className="lrow__title">{album.title}</Link>
        <Link to={`/artist/${encId(album.artist.id)}`} className="link lrow__artist">{album.artist.name}</Link>
      </div>
      {album.year ? <Link to={`/albums?year=${album.year}`} className="link lrow__year">{album.year}</Link> : <span />}
      <FormatBadge format={album.format} source={album.source} />
    </div>
  );
}
