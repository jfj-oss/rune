import { useQuery } from '@tanstack/react-query';
import { FileUp, ListMusic, MoreHorizontal, Play, Plus, Sparkles } from 'lucide-react';
import { useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { LibraryTabs, LibSearch } from './Albums';
import { MenuItem, Popover } from '../components/Popover';
import { PlaylistCover } from '../components/PlaylistCover';
import { Empty, SectionHead } from '../components/Rows';
import { useIsDesktop } from '../hooks/useMedia';
import { isLiked, usePlaylistPlay } from '../hooks/usePlaylistPlay';
import { encId, plural } from '../lib/format';
import { isRunePlaylist, type RunePlaylistSummary } from '../lib/playlists';
import { playlistApi } from '../playlistApi';
import { usePlaylistUi } from '../store/playlistUi';
import { useSpotify } from '../store/spotify';
import { useUi } from '../store/ui';
import { useQueryClient } from '@tanstack/react-query';

function PlaylistCard({ p }: { p: RunePlaylistSummary }) {
  const { play } = usePlaylistPlay();
  const href = `/playlist/${encId(p.id)}`;
  const rune = isRunePlaylist(p.id);
  const smart = rune && p.kind === 'smart';
  return (
    <article className="card plcard">
      <div className="card__art">
        <Link to={href} className="card__artlink" aria-label={p.name} tabIndex={-1}><PlaylistCover id={p.id} name={p.name} imageUrl={p.imageUrl} albumIds={p.coverAlbumIds} smart={smart} /></Link>
        {!rune && <span className="card__badge"><span className="badge badge--spotify"><i className="badge__dot" />Spotify</span></span>}
        {smart && <span className="card__badge"><span className="badge"><Sparkles size={11} /> Smart</span></span>}
        <button className="card__play" aria-label={`Play ${p.name}`} onClick={() => void play(p.id)}><Play size={18} fill="currentColor" /></button>
      </div>
      <Link to={href} className="card__title" title={p.name}>{p.name}</Link>
      <div className="card__sub">{p.owner ? `${p.owner} · ` : ''}{plural(p.trackCount, 'track')}</div>
    </article>
  );
}

export default function Playlists() {
  const desktop = useIsDesktop();
  const nav = useNavigate();
  const qc = useQueryClient();
  const connected = useSpotify((s) => s.connected);
  const loaded = useSpotify((s) => s.loaded);
  const ui = usePlaylistUi.getState();
  const file = useRef<HTMLInputElement>(null);
  const q = useQuery({ queryKey: ['playlists'], queryFn: () => api.playlists() });
  const [params, setParams] = useSearchParams();
  const find = params.get('q') ?? '';
  const setFind = (v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set('q', v); else n.delete('q'); return n; }, { replace: true });
  const every = q.data ?? [];
  const needle = fold(find);
  const all = needle ? every.filter((p) => fold(`${p.name} ${p.owner ?? ''}`).includes(needle)) : every;
  const mine = all.filter((p) => isRunePlaylist(p.id));
  const spotify = all.filter((p) => !isRunePlaylist(p.id)).sort((a, b) => Number(isLiked(b.id)) - Number(isLiked(a.id)));

  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const d = await playlistApi.importM3u8(await f.text(), f.name.replace(/\.(m3u8?|txt)$/i, ''));
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      useUi.getState().toast(d.skipped ? `Imported “${d.name}” — ${d.imported ?? 0} tracks found, ${d.skipped} not in your library` : `Imported “${d.name}”`);
      nav(`/playlist/${encId(d.id)}`);
    } catch { useUi.getState().toast('Could not import that playlist file'); }
    if (file.current) file.current.value = '';
  };

  const actions = (
    <div className="libhead__actions">
      <button className="btn btn--primary" onClick={() => ui.openNew()}><Plus size={18} /> New playlist</button>
      <Popover
        placement="bottom-end"
        trigger={({ toggle }) => <button className="btn btn--icon" aria-label="More playlist actions" onClick={toggle}><MoreHorizontal size={20} /></button>}
      >
        {(close) => (
          <div role="menu" className="menu">
            <MenuItem icon={<Sparkles size={16} />} onClick={() => { close(); ui.openSmart(); }}>New smart playlist…</MenuItem>
            <MenuItem icon={<FileUp size={16} />} onClick={() => { close(); file.current?.click(); }}>Import .m3u8…</MenuItem>
          </div>
        )}
      </Popover>
      <input ref={file} type="file" accept=".m3u8,.m3u,audio/x-mpegurl,application/vnd.apple.mpegurl" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
    </div>
  );

  return (
    <div className="page page--playlists">
      {!desktop && <LibraryTabs active="playlists" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Playlists</h1>
          <p className="pagehead__sub">{q.isLoading ? ' ' : needle ? `${all.length} of ${plural(every.length, 'playlist')}` : plural(every.length, 'playlist')}</p>
        </div>
        {actions}
      </header>
      {every.length > 0 && (
        <div className="toolbar">
          <LibSearch value={find} onChange={setFind} label="Find in playlists" />
        </div>
      )}
      {q.isError ? (
        <Empty title="Could not load playlists" icon={<ListMusic size={28} />}>Is the rune server running?</Empty>
      ) : q.isLoading ? (
        <div className="grid grid--lib">{Array.from({ length: 12 }, (_, i) => <div key={i} className="card card--skeleton"><div className="card__art"><div className="cover shimmer" /></div><div className="skel skel--line" /><div className="skel skel--line skel--short" /></div>)}</div>
      ) : (
        <>
          {needle && all.length === 0 && (
            <Empty title="No playlists match" icon={<ListMusic size={28} />}>Nothing is called “{find}”. <button className="link" onClick={() => setFind('')}>Clear the search</button></Empty>
          )}
          {!needle && mine.length === 0 && (
            <Empty title="Make your first playlist" icon={<ListMusic size={28} />}>
              Playlists in rune can mix local files and Spotify tracks. Create one here, or use “Add to playlist” on any track or album.<br /><br />
              <button className="btn btn--primary" onClick={() => ui.openNew()}><Plus size={18} /> New playlist</button>
            </Empty>
          )}
          {mine.length > 0 && (
            <section className="plsec">
              <SectionHead title="Your playlists" />
              <div className="grid grid--lib">{mine.map((p) => <PlaylistCard key={p.id} p={p} />)}</div>
            </section>
          )}
          {spotify.length > 0 ? (
            <section className="plsec">
              <SectionHead title="From Spotify" />
              <div className="grid grid--lib">{spotify.map((p) => <PlaylistCard key={p.id} p={p} />)}</div>
            </section>
          ) : (
            !needle && loaded && !connected && (
              <p className="plnote">Connect Spotify to see your Spotify playlists and Liked Songs here too. <a className="link" href="/api/spotify/login">Connect Spotify</a></p>
            )
          )}
        </>
      )}
    </div>
  );
}

/** Lower-case, accents stripped: “Café” finds “cafe”. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}
