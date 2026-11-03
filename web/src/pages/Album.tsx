import type { Album, AlbumDetails, Artist } from '@liner/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Copy, ListEnd, MoreHorizontal, Play, Plus, Radio, Shuffle, Star, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { FormatBadge, AlbumCard } from '../components/AlbumCard';
import { Connections } from '../components/album/Connections';
import { Credits } from '../components/album/Credits';
import { AboutMeta } from '../components/album/Editions';
import { FixMatchBanner, FixMatchDialog } from '../components/album/FixMatch';
import { ArtistNotes } from '../components/album/Notes';
import { Prose, Reception, ScoreChip } from '../components/album/Reception';
import { TrackList } from '../components/album/TrackList';
import { PlayStats } from '../components/discover/PlayStats';
import { MobileBack } from '../components/MobileBack';
import { SaveButton } from '../components/SaveButton';
import { Cover } from '../components/Cover';
import { AddToPlaylistItem } from '../components/AddToPlaylist';
import { MenuItem, Popover } from '../components/Popover';
import { Empty, HScroll, QuietNote, SectionHead, SourceLink } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { useCoverColor } from '../hooks/useCoverColor';
import { useScrollRoot } from '../hooks/scrollRoot';
import { paletteFromColour } from '../lib/dither';
import { albumItems, usePlay } from '../hooks/usePlay';
import { encId, formatTotalLength, plural } from '../lib/format';
import type { AlbumEditions } from '../lib/discover';
import { textPreview } from '../lib/previews';
import { startRadio } from '../lib/radio';
import { usePreview } from '../store/preview';
import { useUi } from '../store/ui';

type SectionId = 'tracks' | 'review' | 'about' | 'credits';

export default function AlbumPage() {
  const params = useParams();
  const id = decodeURIComponent(params.id ?? '');
  const loc = useLocation();
  const album = useQuery({ queryKey: ['album', id], queryFn: () => api.album(id) });
  const details = useQuery({ queryKey: ['details', id], queryFn: () => api.details(id), retry: false, staleTime: 5 * 60_000 });
  const editions = useQuery({ queryKey: ['editions', id], queryFn: () => discoverApi.editions(id), staleTime: 5 * 60_000 });
  const artistId = album.data?.artist.id;
  const artist = useQuery({ queryKey: ['artist', artistId], queryFn: () => api.artist(artistId!), enabled: !!artistId });

  if (album.isError) return <div className="page"><Empty title="Album not found">It may have been removed from the library.</Empty></div>;
  if (!album.data) return <AlbumSkeleton />;
  return <AlbumView album={album.data} details={details} editions={editions} artist={artist.data} hash={loc.hash} />;
}

function AlbumSkeleton() {
  return (
    <div className="page page--album">
      <div className="ahero"><div className="ahero__inner">
        <div className="ahero__cover"><div className="cover shimmer" /></div>
        <div className="ahero__txt"><div className="skel skel--line shimmer" style={{ width: 80 }} /><div className="skel skel--title shimmer" /><div className="skel skel--line shimmer" style={{ width: '50%' }} /></div>
      </div></div>
    </div>
  );
}

function AlbumView({ album, details, editions, artist, hash }: { album: Album; details: UseQueryResult<AlbumDetails | null>; editions: UseQueryResult<AlbumEditions>; artist?: Artist; hash: string }) {
  const root = useScrollRoot();
  const { playAlbum, enqueueAlbum } = usePlay();
  const toast = useUi((s) => s.toast);
  const openPreview = usePreview((s) => s.open);
  const [fixing, setFixing] = useState(false);
  const d = details.data;

  // the dither dots take this album's cover colour while the page is open (and blend back when it closes)
  const tint = useCoverColor(album);
  const setPagePalette = useUi((s) => s.setPagePalette);
  useEffect(() => {
    if (!tint.startsWith('rgb')) return; // still the hash fallback: wait for the real cover colour
    setPagePalette(paletteFromColour(tint));
  }, [tint, setPagePalette]);
  useEffect(() => () => setPagePalette(null), [setPagePalette]);

  // the tab strip is clear glass until it sticks to the top, so the hero fades into the page without an edge
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const r = root.current, el = sentinel.current;
    if (!r || !el) return;
    const obs = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 2), { root: r, threshold: 0 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [root, album.id]);
  const loadingDetails = details.isLoading;

  const totalMs = album.tracks.reduce((n, t) => n + t.durationMs, 0);
  const lowConf = album.source === 'local' && album.matchConfidence !== undefined && album.matchConfidence < 0.7;

  const ed = editions.data;
  const loadingEditions = editions.isLoading;
  const hasEditionFacts = !!ed && (!!ed.originalReleaseDate || !!ed.releaseGroupType || ed.secondaryTypes.length > 0 || ed.editions.length > 0 || ed.otherVersionsInLibrary.length > 0);
  const hasReview = !!d && (!!d.reception || d.scores.length > 0 || d.quotes.length > 0);
  const hasAbout = (!!d && (d.artistNotes.length > 0 || !!d.background)) || hasEditionFacts;
  const aboutLoading = loadingDetails || loadingEditions;
  const hasCredits = album.credits.length > 0;
  const tabs = useMemo(() => {
    const t: { id: SectionId; label: string }[] = [{ id: 'tracks', label: 'Tracks' }];
    if (hasReview || loadingDetails) t.push({ id: 'review', label: 'Review' });
    if (hasAbout || aboutLoading) t.push({ id: 'about', label: 'About' });
    if (hasCredits) t.push({ id: 'credits', label: 'Credits' });
    return t;
  }, [hasReview, hasAbout, aboutLoading, hasCredits, loadingDetails]);

  const [active, setActive] = useState<SectionId>('tracks');
  const refs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const setRef = (k: SectionId) => (el: HTMLElement | null) => { refs.current[k] = el; };

  // scroll-spy
  useEffect(() => {
    const r = root.current;
    if (!r) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive((vis.target as HTMLElement).dataset.sec as SectionId);
      },
      { root: r, rootMargin: '-110px 0px -65% 0px', threshold: 0 },
    );
    Object.values(refs.current).forEach((el) => el && obs.observe(el));
    return () => obs.disconnect();
  }, [root, tabs.length, d, album.id]);

  const go = (id: SectionId) => { refs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(id); };

  // honour #review etc. (from Now Playing)
  useEffect(() => {
    const h = hash.replace('#', '') as SectionId;
    if (!h || !refs.current[h]) return;
    const t = setTimeout(() => refs.current[h]?.scrollIntoView({ block: 'start' }), 60);
    return () => clearTimeout(t);
  }, [hash, d]);

  const more = (artist?.albums ?? []).filter((a) => a.id !== album.id);
  const year = album.year;

  return (
    <div className="page page--album">
      {lowConf && <FixMatchBanner onFix={() => setFixing(true)} />}
      <section className="ahero">
        <div className="ahero__bg" aria-hidden>
          <img src={coverSrc(album, 200)} alt="" />
          <div className="ahero__wash" />
        </div>
        <MobileBack />
        <div className="ahero__inner">
          <div className="ahero__cover"><Cover album={album} size={600} eager sizes="300px" /></div>
          <div className="ahero__txt">
            <span className="eyebrow ahero__kind">Album</span>
            <h1 className="ahero__title">{album.title}</h1>
            <p className="ahero__meta">
              <Link to={`/artist/${encId(album.artist.id)}`} className="link link--strong">{album.artist.name}</Link>
              {year ? <><span className="dot">·</span><Link to={`/albums?year=${year}`} className="link">{year}</Link></> : null}
              {album.label ? <><span className="dot">·</span><Link to={`/albums?label=${encodeURIComponent(album.label)}`} className="link">{album.label}</Link></> : null}
              <span className="dot">·</span><span>{plural(album.tracks.length, 'track')}, {formatTotalLength(totalMs)}</span>
            </p>
            <div className="ahero__tags">
              <FormatBadge format={album.format} source={album.source} />
              {album.genres.map((g) => <Link key={g} to={`/genres/${encodeURIComponent(g)}`} className="chip">{g}</Link>)}
            </div>
            <div className="ahero__actions">
              <button className="btn btn--primary" onClick={() => void playAlbum(album.id)}><Play size={18} fill="currentColor" /> Play</button>
              <button className="btn" onClick={() => void playAlbum(album.id, { shuffle: true })}><Shuffle size={17} /> Shuffle</button>
              <button className="btn" onClick={() => void enqueueAlbum(album.id)}><Plus size={18} /> Queue</button>
              {album.source === 'spotify' && <SaveButton albumId={album.id} />}
              <Popover
                placement="bottom-start"
                trigger={({ toggle }) => <button className="btn btn--icon" aria-label="More actions" onClick={toggle}><MoreHorizontal size={20} /></button>}
              >
                {(close) => (
                  <div role="menu" className="menu">
                    <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void enqueueAlbum(album.id, true); }}>Play next</MenuItem>
                    <AddToPlaylistItem close={close} target={{ what: `${album.title} · ${plural(album.tracks.length, 'track')}`, newName: album.title, resolve: () => albumItems(album) }} />
                    {album.source === 'local' && <MenuItem icon={<Radio size={16} />} onClick={() => { close(); void startRadio('album', album.id); }}>Start radio</MenuItem>}
                    {album.source === 'local' && <MenuItem icon={<Wrench size={16} />} onClick={() => { close(); setFixing(true); }}>Fix match</MenuItem>}
                    {album.folderPath && (
                      <MenuItem icon={<Copy size={16} />} onClick={() => { close(); void navigator.clipboard?.writeText(album.folderPath ?? '').then(() => toast('Folder path copied'), () => toast(album.folderPath ?? '')); }}>Copy folder path</MenuItem>
                    )}
                  </div>
                )}
              </Popover>
            </div>
            {d && d.scores.length > 0 && (
              <div className="ahero__scores" aria-label="Critic scores">{d.scores.map((s) => <ScoreChip key={s.outlet} s={s} details={d} />)}</div>
            )}
          </div>
        </div>
      </section>

      <div className="atabs__sentinel" ref={sentinel} aria-hidden />
      <nav className={`atabs${stuck ? ' is-stuck' : ''}`} aria-label="Album sections">
        <div className="atabs__in" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={active === t.id} className={active === t.id ? 'is-active' : ''} onClick={() => go(t.id)}>{t.label}</button>
          ))}
        </div>
      </nav>

      <div className="abody">
        <section className="asec" id="tracks" data-sec="tracks" ref={setRef('tracks')}>
          <SectionHead title="Tracks" />
          <TrackList album={album} />
        </section>

        {loadingDetails && (
          <section className="asec" id="review" data-sec="review" ref={setRef('review')}>
            <SectionHead title="Critical reception" />
            <div className="lookup" aria-live="polite">
              <p className="muted">Looking up reviews…</p>
              <div className="skel skel--line shimmer" /><div className="skel skel--line shimmer" style={{ width: '92%' }} /><div className="skel skel--line shimmer" style={{ width: '78%' }} /><div className="skel skel--line shimmer" style={{ width: '86%' }} />
            </div>
          </section>
        )}

        {!loadingDetails && !aboutLoading && !hasReview && !hasAbout && (
          <section className="asec asec--quiet"><QuietNote icon={<Star size={17} />}>No reviews found for this album.</QuietNote></section>
        )}

        {d && hasReview && (
          <section className="asec" id="review" data-sec="review" ref={setRef('review')}>
            <SectionHead title="Critical reception" />
            <Reception details={d} />
          </section>
        )}

        {aboutLoading && (
          <section className="asec" id="about" data-sec="about" ref={setRef('about')}>
            <SectionHead title="About" />
            <AboutMeta album={album} editions={ed} loading={loadingEditions} />
            {loadingDetails && (
              <div className="about__part" aria-live="polite">
                <p className="muted secnote">Looking up background…</p>
                <div className="skel skel--line shimmer" /><div className="skel skel--line shimmer" style={{ width: '92%' }} /><div className="skel skel--line shimmer" style={{ width: '78%' }} />
              </div>
            )}
          </section>
        )}

        {!aboutLoading && hasAbout && (
          <section className="asec" id="about" data-sec="about" ref={setRef('about')}>
            <SectionHead title="About" />
            <AboutMeta album={album} editions={ed} loading={false} />
            {d && d.artistNotes.length > 0 && (
              <div className="about__part">
                <h3 className="eyebrow about__sub">In the artist’s words</h3>
                <ArtistNotes notes={d.artistNotes} album={album} />
              </div>
            )}
            {d?.background && (
              <div className="about__part">
                <h3 className="eyebrow about__sub">Background</h3>
                <div className="bg">
                  <Prose text={d.background.value} lines={9} />
                  <SourceLink source={d.background.source} url={d.background.url} onPreview={() => openPreview(textPreview('Background', 'Background', d.background!))} />
                </div>
              </div>
            )}
          </section>
        )}

        {hasCredits && (
          <section className="asec" id="credits" data-sec="credits" ref={setRef('credits')}>
            <SectionHead title="Credits" />
            <Credits album={album} />
          </section>
        )}

        <section className="asec">
          <SectionHead title="Your plays" />
          <PlayStats kind="album" id={album.id} />
        </section>

        <Connections albumId={album.id} />

        {more.length > 0 && (
          <section className="asec">
            <SectionHead title={`More by ${album.artist.name}`} to={`/artist/${encId(album.artist.id)}`} />
            <HScroll>{more.map((a) => <AlbumCard key={a.id} album={a} width={170} />)}</HScroll>
          </section>
        )}
      </div>

      {fixing && <FixMatchDialog albumId={album.id} onClose={() => setFixing(false)} />}
    </div>
  );
}
