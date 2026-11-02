import { useVirtualizer } from '@tanstack/react-virtual';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Avatar } from '../components/album/Credits';
import { Empty } from '../components/Rows';
import { useScrollRoot } from '../hooks/scrollRoot';
import { useIsDesktop } from '../hooks/useMedia';
import { encId, plural } from '../lib/format';
import { LibraryTabs } from './Albums';

interface ArtistCard { id: string; name: string; n: number }

/** Grid metrics mirror `.artgrid` (auto-fill, min 150 px, 30 px / 20 px gaps). */
const MIN = 150;
const GAP_X = 20;
const GAP_Y = 30;
const AVATAR_MAX = 132;

/** No artists-list endpoint in the contract yet: derive artists from the album list. */
export default function Artists() {
  const desktop = useIsDesktop();
  const q = useQuery({ queryKey: ['albums', 'for-artists'], queryFn: () => api.albums({ sort: 'artist', limit: 1000 }) });
  const map = new Map<string, ArtistCard>();
  for (const a of q.data?.items ?? []) {
    const e = map.get(a.artist.id);
    if (e) e.n++; else map.set(a.artist.id, { id: a.artist.id, name: a.artist.name, n: 1 });
  }
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="page page--artists">
      {!desktop && <LibraryTabs active="artists" />}
      <header className="libhead"><div><h1 className="pagehead__title">Artists</h1><p className="pagehead__sub">{q.data ? plural(list.length, 'artist') : ' '}</p></div></header>
      {q.isError ? <Empty title="Could not load artists" /> : <ArtistGrid list={list} />}
    </div>
  );
}

/** Windowed artist grid: only the visible rows exist in the DOM (the library can have thousands). */
function ArtistGrid({ list }: { list: ArtistCard[] }) {
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
  }, [root]);

  const cols = Math.max(1, Math.floor((width + GAP_X) / (MIN + GAP_X)));
  const cardW = cols > 0 ? (width - GAP_X * (cols - 1)) / cols : 0;
  const rowH = Math.min(AVATAR_MAX, cardW) + 64 + GAP_Y;
  const rows = Math.ceil(list.length / cols);

  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => root.current,
    estimateSize: () => rowH,
    overscan: 4,
    scrollMargin: offset,
  });
  useEffect(() => { v.measure(); }, [rowH, v]);

  const vis = v.getVirtualItems();
  return (
    <div ref={wrap} className="vgrid" style={{ height: v.getTotalSize() }}>
      {width > 0 && vis.map((row) => {
        const start = row.index * cols;
        const slice = list.slice(start, start + cols);
        return (
          <div
            key={row.key}
            className="vgrid__row"
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${row.start - v.options.scrollMargin}px)`, gap: `${GAP_Y}px ${GAP_X}px`, gridTemplateColumns: `repeat(${cols}, ${cardW}px)` }}
          >
            {slice.map((a) => (
              <Link key={a.id} to={`/artist/${encId(a.id)}`} className="artcard">
                <Avatar name={a.name} id={a.id} size={132} />
                <b>{a.name}</b>
                <span>{plural(a.n, 'album')}</span>
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}
