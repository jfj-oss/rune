import { useQuery } from '@tanstack/react-query';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { ArrowDownWideNarrow, Check, Copy, Disc3, Download, GripVertical, HardDrive, ListEnd, ListOrdered, ListPlus, ListStart, Lock, MoreHorizontal, Play, Plus, Radio, Shuffle, Sparkles, Trash2, User, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { AddToPlaylistItem } from '../components/AddToPlaylist';
import { Cover } from '../components/Cover';
import { Dialog } from '../components/Dialog';
import { Eq } from '../components/Eq';
import { InlineText } from '../components/InlineText';
import { MobileBack } from '../components/MobileBack';
import { MenuItem, Popover } from '../components/Popover';
import { PlaylistCover } from '../components/PlaylistCover';
import { Empty } from '../components/Rows';
import { useScrollRoot } from '../hooks/scrollRoot';
import { usePlaylistActions } from '../hooks/usePlaylistEdit';
import { isLiked, playlistItem, playlistItems, playlistUri, usePlaylistPlay } from '../hooks/usePlaylistPlay';
import { encId, formatDuration, formatTotalLength, plural } from '../lib/format';
import { hasOverlay, isEditable, isMixed, isOverlayRow, isRunePlaylist, isSmartPlaylist, orderPlaylist, rowEditable, selectRow, type RunePlaylistDetail } from '../lib/playlists';
import { startRadio } from '../lib/radio';
import { currentItem, usePlayer } from '../store/player';
import { usePlaylistUi } from '../store/playlistUi';

export default function PlaylistPage() {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
  if (q.isError && !q.data) return <div className="page"><Empty title="Playlist not found">It may have been deleted, removed from Spotify, or hasn’t synced yet.</Empty></div>;
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

function PlaylistView({ d: raw }: { d: RunePlaylistDetail }) {
  const { play, enqueue } = usePlaylistPlay();
  const nav = useNavigate();
  const actions = usePlaylistActions();
  const order = usePlaylistUi((s) => s.order);
  const setOrder = usePlaylistUi((s) => s.setOrder);
  const { view: d, origIndex, sorted } = useMemo(() => orderPlaylist(raw, order), [raw, order]);
  const canSort = !isSmartPlaylist(raw) && raw.tracks.some((t) => t.addedAt != null);
  const items = useMemo(() => playlistItems(d), [d]);
  const totalMs = useMemo(() => d.tracks.reduce((n, t) => n + t.durationMs, 0), [d]);
  const liked = isLiked(d.id);
  const rune = isRunePlaylist(d.id);
  const smart = isSmartPlaylist(d);
  const editable = isEditable(d);
  const mixed = isMixed(d.tracks);
  const bgSrc = d.imageUrl ?? (d.tracks[0] ? coverSrc(d.tracks[0].album, 200) : undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const duplicate = async () => {
    const copy = await actions.duplicate(d.id);
    if (copy) nav(`/playlist/${encId(copy.id)}`);
  };
  const del = async () => {
    setConfirmDelete(false);
    if (await actions.remove(d.id, d.name)) nav('/playlists', { replace: true });
  };

  return (
    <div className={`page page--album page--playlist${rune ? ' page--rune' : ''}`}>
      <section className="ahero">
        <div className={`ahero__bg${liked ? ' ahero__bg--liked' : ''}`} aria-hidden>
          {!liked && bgSrc && <img src={bgSrc} alt="" referrerPolicy="no-referrer" />}
          <div className="ahero__wash" />
        </div>
        <MobileBack />
        <div className="ahero__inner">
          <div className="ahero__cover"><PlaylistCover id={d.id} name={d.name} imageUrl={d.imageUrl} albumIds={d.coverAlbumIds} smart={smart} iconSize={96} /></div>
          <div className="ahero__txt">
            <span className="eyebrow ahero__kind">{smart ? 'Smart playlist' : rune ? 'Playlist' : 'Spotify playlist'}</span>
            <h1 className="ahero__title">
              {rune ? <InlineText value={d.name} label="playlist name" editable maxLength={200} onCommit={(v) => void actions.rename(d.id, v)} /> : d.name}
            </h1>
            {rune ? (
              <p className="ahero__desc">
                <InlineText value={d.description ?? ''} label="description" editable multiline allowEmpty maxLength={5000} placeholder="Add a description" onCommit={(v) => void actions.describe(d.id, v)} />
              </p>
            ) : d.description ? <p className="ahero__desc">{d.description}</p> : null}
            <p className="ahero__meta">
              {d.owner && <><span className="link--strong">{d.owner}</span><span className="dot">·</span></>}
              <span>{plural(d.trackCount || d.tracks.length, 'track')}, {formatTotalLength(totalMs)}</span>
            </p>
            <div className="ahero__tags">
              {rune ? (
                <>
                  <span className="badge badge--rune"><i className="badge__dot badge__dot--rune" />rune</span>
                  {smart && <span className="badge" title="Rules are re-checked every time you open it"><Sparkles size={12} /> Smart · updates itself</span>}
                  {mixed && <span className="badge" title="Contains local files and Spotify tracks">Local + Spotify</span>}
                </>
              ) : (
                <>
                  <span className="badge badge--spotify"><i className="badge__dot" />From Spotify</span>
                  <span className="badge" title="Spotify’s own tracks can only be changed in Spotify. Local files you add here are kept in rune."><Lock size={11} /> Spotify rows locked</span>
                </>
              )}
            </div>
            <div className="ahero__actions">
              <button className="btn btn--primary" onClick={() => void play(d.id)}><Play size={18} fill="currentColor" /> Play</button>
              <button className="btn" onClick={() => void play(d.id, { shuffle: true })}><Shuffle size={17} /> Shuffle</button>
              <button className="btn" onClick={() => void enqueue(d.id)}><Plus size={18} /> Queue</button>
              {canSort && (
                <button className="btn" onClick={() => setOrder(order === 'added' ? 'playlist' : 'added')} title="Change the track order">
                  {order === 'added' ? <><ArrowDownWideNarrow size={16} /> Newest first</> : <><ListOrdered size={16} /> Playlist order</>}
                </button>
              )}
              {!rune && <button className="btn" onClick={() => void duplicate()}><Copy size={16} /> Duplicate as rune playlist</button>}
              <Popover
                placement="bottom-start"
                trigger={({ toggle }) => <button className="btn btn--icon" aria-label="More actions" onClick={toggle}><MoreHorizontal size={20} /></button>}
              >
                {(close) => (
                  <div role="menu" className="menu">
                    <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void usePlayer.getState().enqueueItems(items, true); }}>Play next</MenuItem>
                    {rune && <MenuItem icon={<Copy size={16} />} onClick={() => { close(); void duplicate(); }}>Duplicate</MenuItem>}
                    <MenuItem icon={<Download size={16} />} onClick={() => { close(); void actions.exportM3u8(d.id, d.name); }}>Export .m3u8</MenuItem>
                    {rune && <MenuItem icon={<Trash2 size={16} />} danger onClick={() => { close(); setConfirmDelete(true); }}>Delete playlist</MenuItem>}
                  </div>
                )}
              </Popover>
            </div>
            {!rune && <p className="ahero__note"><Lock size={12} /> Synced from Spotify, so its Spotify tracks stay locked. Add local files with “Add to playlist” — they stay in rune, never go to Spotify, and can be moved or removed. “Duplicate as rune playlist” makes a copy where everything is editable.</p>}
          </div>
        </div>
      </section>
      <div className="abody">
        {d.tracks.length === 0 ? (
          rune ? (
            <Empty title={smart ? 'Nothing matches yet' : 'This playlist is empty'}>
              {smart ? 'No track matches the rules right now. It fills itself as your library changes.' : 'Add tracks from any album or track list with “Add to playlist”, or save the queue as a playlist.'}
              {!smart && <><br /><br /><Link className="btn" to="/albums">Browse albums</Link></>}
            </Empty>
          ) : <Empty title="No tracks yet">This playlist is empty, or hasn’t finished syncing.</Empty>
        ) : <PlaylistTracks d={d} items={items} editable={editable || hasOverlay(d)} mixed={mixed} origIndex={origIndex} reorder={!sorted} />}
      </div>
      {confirmDelete && (
        <Dialog
          title="Delete playlist?"
          onClose={() => setConfirmDelete(false)}
          className="dialog--sheet"
          footer={(
            <>
              <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button className="btn btn--danger" onClick={() => void del()}><Trash2 size={15} /> Delete</button>
            </>
          )}
        >
          <p className="dialog__lead">“{d.name}” will be deleted. The tracks themselves stay in your library.</p>
        </Dialog>
      )}
    </div>
  );
}

const ROW = 56;

function SourceBadge({ source, format }: { source: string; format?: string }) {
  return source === 'spotify'
    ? <span className="srcbadge srcbadge--spotify" title="Spotify"><i className="badge__dot" />Spotify</span>
    : <span className="srcbadge" title="Local file">{format ? format.toUpperCase() : 'Local'}</span>;
}

function PlaylistTracks({ d, items, editable, mixed, origIndex, reorder }: { d: RunePlaylistDetail; items: ReturnType<typeof playlistItems>; editable: boolean; mixed: boolean; origIndex: number[]; reorder: boolean }) {
  /** Shown row -> position in the playlist (rows are shown newest-first unless "Playlist order"). */
  const pos = (i: number) => origIndex[i] ?? i;
  const root = useScrollRoot();
  const wrap = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const nav = useNavigate();
  const actions = usePlaylistActions();
  const state = usePlayer((s) => s.state);
  const playItems = usePlayer((s) => s.playItems);
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const cur = currentItem(state);
  const ctx = playlistUri(d.id);
  const n = d.tracks.length;

  // ---- selection (editable playlists)
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  useEffect(() => { setSel(new Set()); setAnchor(null); }, [d.id]);
  useEffect(() => { setSel((s) => (s.size && [...s].some((i) => i >= n) ? new Set([...s].filter((i) => i < n)) : s)); }, [n]);
  const clearSel = useCallback(() => { setSel(new Set()); setAnchor(null); setSelectMode(false); }, []);
  const pick = (i: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (!rowEditable(d, d.tracks[i]!)) return;
    const r = selectRow(sel, anchor, i, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey || selectMode });
    setSel(r.sel);
    setAnchor(r.anchor);
  };
  const removeSelected = useCallback(() => {
    if (!sel.size) return;
    const positions = [...sel].map(pos).sort((a, b) => a - b);
    clearSel();
    void actions.removeAt(d.id, positions);
  }, [sel, clearSel, actions, d.id, origIndex]);

  useEffect(() => {
    if (!editable) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); removeSelected(); }
      else if (e.key === 'Escape' && sel.size) clearSel();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setSel(new Set(d.tracks.flatMap((t, i) => (rowEditable(d, t) ? [i] : [])))); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [editable, sel, d, removeSelected, clearSel]);

  // ---- drag to reorder (pointer based, with edge auto-scroll)
  const [drag, setDrag] = useState<{ from: number; dy: number } | null>(null);
  const dragRef = useRef<{ from: number; startY: number; startScroll: number; y: number; raf: number } | null>(null);
  const dragFrom = useRef<number | null>(null);
  const target = drag ? Math.max(0, Math.min(n - 1, drag.from + Math.round(drag.dy / ROW))) : -1;

  const sync = () => {
    const g = dragRef.current;
    if (!g) return;
    setDrag({ from: g.from, dy: g.y - g.startY + ((root.current?.scrollTop ?? 0) - g.startScroll) });
  };
  const loop = () => {
    const g = dragRef.current;
    const r = root.current;
    if (!g || !r) return;
    const box = r.getBoundingClientRect();
    const top = box.top + 70;
    const bottom = box.bottom - 110;
    const speed = g.y < top ? -Math.min(24, (top - g.y) / 4 + 2) : g.y > bottom ? Math.min(24, (g.y - bottom) / 4 + 2) : 0;
    if (speed) { r.scrollTop += speed; sync(); }
    g.raf = requestAnimationFrame(loop);
  };
  const endDrag = (commit: boolean) => {
    const g = dragRef.current;
    if (!g) return;
    cancelAnimationFrame(g.raf);
    const dy = g.y - g.startY + ((root.current?.scrollTop ?? 0) - g.startScroll);
    const to = Math.max(0, Math.min(n - 1, g.from + Math.round(dy / ROW)));
    dragRef.current = null;
    dragFrom.current = null;
    setDrag(null);
    if (commit && to !== g.from) { clearSel(); void actions.move(d.id, g.from, to); }
  };
  const onGripDown = (e: RPointerEvent<HTMLButtonElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { from: i, startY: e.clientY, startScroll: root.current?.scrollTop ?? 0, y: e.clientY, raf: 0 };
    dragFrom.current = i;
    setDrag({ from: i, dy: 0 });
    dragRef.current.raf = requestAnimationFrame(loop);
  };
  const onGripMove = (e: RPointerEvent<HTMLButtonElement>) => { if (dragRef.current) { dragRef.current.y = e.clientY; sync(); } };
  useEffect(() => () => { if (dragRef.current) cancelAnimationFrame(dragRef.current.raf); }, []);

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

  const rangeExtractor = useCallback((range: Range) => {
    const base = defaultRangeExtractor(range);
    const f = dragFrom.current;
    return f !== null && f < range.count && !base.includes(f) ? [...base, f].sort((a, b) => a - b) : base;
  }, []);
  const v = useVirtualizer({ count: n, getScrollElement: () => root.current, estimateSize: () => ROW, overscan: 10, scrollMargin: offset, rangeExtractor });
  useEffect(() => { v.measure(); }, [offset, v]);

  const spotifyList = !isRunePlaylist(d.id);
  const mineCount = d.tracks.reduce((c, t) => c + (rowEditable(d, t) ? 1 : 0), 0);
  const selectedItems = () => [...sel].sort((a, b) => a - b).map((i) => items[i]!).filter(Boolean);

  return (
    <div className={`ptracks${editable ? ' ptracks--edit' : ''}${drag ? ' is-dragging' : ''}`} role="table" aria-label="Tracks">
      {editable && (
        <div className={`ptools${sel.size ? ' ptools--on' : ''}`} role="toolbar" aria-label="Selection">
          {sel.size === 0 ? (
            <>
              {mineCount > 0 && <button className={`btn btn--sm btn--ghost${selectMode ? ' is-on' : ''}`} aria-pressed={selectMode} onClick={() => setSelectMode((m) => !m)}><Check size={14} /> Select</button>}
              <span className="ptools__hint">
                {spotifyList
                  ? (mineCount > 0 ? <><HardDrive size={13} /> Your local rows can be {reorder ? <>dragged <GripVertical size={13} /> and </> : ''}removed · Spotify rows are locked</> : <>Add local files with “Add to playlist” on any track or album · Spotify rows are locked</>)
                  : reorder ? <>Drag <GripVertical size={13} /> to reorder · click to play · shift or ⌘-click to select</> : <>Newest first · switch to “Playlist order” to drag rows · shift or ⌘-click to select</>}
              </span>
            </>
          ) : (
            <>
              <b className="ptools__n">{sel.size} selected</b>
              <button className="btn btn--sm" aria-label="Add selection to a playlist" onClick={() => usePlaylistUi.getState().openPicker({ title: 'Add to playlist', what: plural(sel.size, 'selected track'), resolve: selectedItems, newName: `${d.name} — selection` })}><ListPlus size={14} /><span className="ptools__lbl">Add to playlist</span></button>
              <button className="btn btn--sm btn--danger" onClick={removeSelected}><Trash2 size={14} /> Remove</button>
              <button className="btn btn--sm btn--ghost" onClick={clearSel} aria-label="Clear selection"><X size={14} /><span className="ptools__lbl">Clear</span></button>
            </>
          )}
        </div>
      )}
      <div className="prow prow--head" role="row">
        {editable && <span />}
        <span>#</span><span>Title</span><span className="prow__albumcol">Album</span><span className="prow__dur">Time</span><span />
      </div>
      <div ref={wrap} className="vgrid" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((row) => {
          const i = row.index;
          const t = d.tracks[i]!;
          const playing = cur?.track.id === t.id && state.queue[state.index]?.track.id === t.id;
          const go = () => void playItems(items, i, { context: ctx });
          const mine = rowEditable(d, t); // rune playlists: every row; Spotify playlists: only rune's local rows
          const overlay = isOverlayRow(d.id, t) && !isRunePlaylist(d.id);
          const picked = sel.has(i);
          let shift = 0;
          if (drag) {
            if (i === drag.from) shift = drag.dy;
            else if (drag.from < target && i > drag.from && i <= target) shift = -ROW;
            else if (drag.from > target && i < drag.from && i >= target) shift = ROW;
          }
          const y = row.start - v.options.scrollMargin + shift;
          return (
            <div
              key={row.key}
              className={`prow${playing ? ' is-playing' : ''}${picked ? ' is-picked' : ''}${drag?.from === i ? ' is-dragging' : ''}${selectMode || sel.size ? ' is-selecting' : ''}`}
              role="row"
              aria-selected={editable ? picked : undefined}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: row.size, transform: `translateY(${y}px)`, transition: drag && drag.from !== i ? 'transform 150ms ease' : undefined, zIndex: drag?.from === i ? 5 : undefined }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a,button,.pop,[role="menu"]')) return;
                // one click plays; selecting is shift / ⌘-click, or any click while "Select" is on
                if (editable && mine && (selectMode || sel.size > 0 || e.shiftKey || e.metaKey || e.ctrlKey)) pick(i, e);
                else go();
              }}
            >
 {editable && !mine && <span className="prow__lock" title="Synced from Spotify — locked"><Lock size={12} /></span>}
              {editable && mine && reorder && (
                <button className="prow__grip" aria-label={`Drag to reorder ${t.title}`} onPointerDown={(e) => onGripDown(e, i)} onPointerMove={onGripMove} onPointerUp={() => endDrag(true)} onPointerCancel={() => endDrag(false)}>
                  <GripVertical size={16} />
                </button>
              )}
              {editable && mine && (selectMode || sel.size > 0) ? (
                <button className={`prow__check${picked ? ' is-on' : ''}`} role="checkbox" aria-checked={picked} aria-label={`Select ${t.title}`} onClick={(e) => { e.stopPropagation(); pick(i, { shiftKey: e.shiftKey, metaKey: true, ctrlKey: false }); }}>
                  {picked && <Check size={13} strokeWidth={3} />}
                </button>
              ) : (
                <button className="trow__num prow__num" aria-label={`Play ${t.title}`} onClick={go}>
                  <span className="trow__n">{playing ? <Eq playing={state.status === 'playing'} /> : i + 1}</span>
                  <Play size={14} fill="currentColor" className="trow__p" />
                </button>
              )}
              <div className="prow__main">
                <span className="prow__art"><Cover album={t.album} sizes="40px" /></span>
                <div className="prow__txt">
                  <span className="prow__line">
                    <span className="prow__name" title={t.title}>{t.title}</span>
                    {overlay ? <span className="srcbadge srcbadge--disk" title="A local file kept in rune — not part of the Spotify playlist"><HardDrive size={10} />on this disk</span> : mixed && !spotifyList && <SourceBadge source={t.source} format={t.format} />}
                  </span>
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
                    <AddToPlaylistItem close={close} target={{ what: t.title, resolve: () => [playlistItem(t)] }} />
                    {t.source === 'local' && <MenuItem icon={<Radio size={16} />} onClick={() => { close(); void startRadio('track', t.id); }}>Start radio</MenuItem>}
                    <MenuItem icon={<Disc3 size={16} />} onClick={() => { close(); nav(`/album/${encId(t.album.id)}`); }}>Go to album</MenuItem>
                    {t.artists[0] && <MenuItem icon={<User size={16} />} onClick={() => { close(); nav(`/artist/${encId(t.artists[0]!.id)}`); }}>Go to artist</MenuItem>}
                    {editable && mine && <MenuItem icon={<Trash2 size={16} />} danger onClick={() => { close(); void actions.removeAt(d.id, [pos(i)]); }}>Remove from playlist</MenuItem>}
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
