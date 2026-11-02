import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronLeft, Search, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { browseApi } from '../browseApi';
import { Cover } from '../components/Cover';
import { Empty } from '../components/Rows';
import { useIsDesktop } from '../hooks/useMedia';
import { tileGradient } from '../lib/color';
import { plural } from '../lib/format';
import type { GenreAlbumQuery, GenreFacet } from '../lib/types';
import { LibraryTabs, VirtualAlbums } from './Albums';
import { CardSkeleton } from '../components/AlbumCard';

export default function Genres() {
  const desktop = useIsDesktop();
  const [text, setText] = useState('');
  const q = useQuery({ queryKey: ['genres'], queryFn: () => browseApi.genres(), staleTime: 60_000 });
  const s = text.trim().toLowerCase();
  const list = (q.data ?? []).filter((g) => !s || g.genre.toLowerCase().includes(s));
  return (
    <div className="page page--genres">
      {!desktop && <LibraryTabs active="genres" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Genres</h1>
          <p className="pagehead__sub">{q.data ? plural(q.data.length, 'genre') : ' '}</p>
        </div>
      </header>
      <div className="toolbar">
        <label className="filterbox">
          <Search size={15} aria-hidden />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter genres" aria-label="Filter genres" />
          {text && <button type="button" className="btn-icon filterbox__x" aria-label="Clear filter" onClick={() => setText('')}><X size={14} /></button>}
        </label>
      </div>
      {q.isError ? (
        <Empty title="Could not load genres">Is the rune server running?</Empty>
      ) : q.isLoading ? (
        <div className="gridgenres">{Array.from({ length: 12 }, (_, i) => <div key={i} className="gtile"><div className="gtile__mosaic shimmer" /><div className="skel skel--line" /></div>)}</div>
      ) : list.length === 0 ? (
        <Empty title="No genres here">{s ? 'Nothing matches that filter.' : 'Genres appear once albums have been tagged or matched.'}</Empty>
      ) : (
        <div className="gridgenres">{list.map((g, i) => <GenreTile key={g.genre} g={g} eager={i < 12} />)}</div>
      )}
    </div>
  );
}

function GenreTile({ g, eager }: { g: GenreFacet; eager?: boolean }) {
  const ids = g.coverAlbumIds.slice(0, 4);
  const single = ids.length === 1;
  return (
    <Link to={`/genres/${encodeURIComponent(g.genre)}`} className="gtile" aria-label={`${g.genre} — ${plural(g.albumCount, 'album')}`}>
      <div className={`gtile__mosaic${single ? ' gtile__mosaic--one' : ''}`}>
        {single ? <Cover album={{ id: ids[0]! }} size={600} sizes="220px" eager={eager} /> : Array.from({ length: 4 }, (_, i) => ids[i]
          ? <Cover key={i} album={{ id: ids[i]! }} sizes="110px" eager={eager} />
          : <div key={i} className="gtile__empty" style={{ background: tileGradient(g.genre + i) }} />)}
      </div>
      <b className="gtile__name">{g.genre}</b>
      <span className="gtile__n">{plural(g.albumCount, 'album')}</span>
    </Link>
  );
}

const SORTS: { id: NonNullable<GenreAlbumQuery['sort']>; label: string }[] = [
  { id: 'artist', label: 'Artist' }, { id: 'title', label: 'Title' }, { id: 'year', label: 'Year' }, { id: 'added', label: 'Date added' },
];
const PAGE = 120;

export function GenrePage() {
  const genre = decodeURIComponent(useParams().genre ?? '');
  const nav = useNavigate();
  const desktop = useIsDesktop();
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.find((s) => s.id === params.get('sort'))?.id ?? 'artist') as NonNullable<GenreAlbumQuery['sort']>;
  const res = useInfiniteQuery({
    queryKey: ['genre-albums', genre, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => browseApi.genreAlbums(genre, { sort, offset: pageParam, limit: PAGE }),
    getNextPageParam: (last, all) => { const n = all.reduce((s, p) => s + p.items.length, 0); return n < last.total ? n : undefined; },
  });
  const items = res.data?.pages.flatMap((p) => p.items) ?? [];
  const total = res.data?.pages[0]?.total ?? 0;
  return (
    <div className="page page--albums">
      {!desktop && <LibraryTabs active="genres" />}
      <Link to="/genres" className="backlink"><ChevronLeft size={15} /> Genres</Link>
      <header className="libhead">
        <div>
          <span className="eyebrow">Genre</span>
          <h1 className="pagehead__title">{genre}</h1>
          <p className="pagehead__sub">{res.isLoading ? ' ' : plural(total, 'album')}</p>
        </div>
      </header>
      <div className="toolbar">
        <span className="toolbar__spacer" />
        <label className="select">
          <span>Sort</span>
          <select value={sort} onChange={(e) => setParams(e.target.value === 'artist' ? {} : { sort: e.target.value }, { replace: true })} aria-label="Sort albums">
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {res.isError ? (
        <Empty title="Could not load this genre">Try <button className="link" onClick={() => nav(0)}>reloading</button>.</Empty>
      ) : res.isLoading ? (
        <div className="grid grid--lib">{Array.from({ length: 12 }, (_, i) => <CardSkeleton key={i} />)}</div>
      ) : total === 0 ? (
        <Empty title="No albums in this genre" />
      ) : (
        <VirtualAlbums items={items} total={total} view="grid" onNeedMore={() => { if (res.hasNextPage && !res.isFetchingNextPage) void res.fetchNextPage(); }} />
      )}
    </div>
  );
}
