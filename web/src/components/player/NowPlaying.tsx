import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ListMusic, ListPlus } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AlbumDetails } from '@liner/shared';
import { api } from '../../api';
import { discoverApi } from '../../discoverApi';
import { useCoverColor } from '../../hooks/useCoverColor';
import { useIsDesktop } from '../../hooks/useMedia';
import { ditherHueOf, type DitherColour } from '../../lib/dither';
import { encId, formatDuration } from '../../lib/format';
import { isLiveTrack } from '../../lib/listenTypes';
import { liveMeta } from '../../lib/live';
import { textPreview } from '../../lib/previews';
import { usePlayer, useSignalPath } from '../../store/player';
import { usePlaylistUi } from '../../store/playlistUi';
import { usePreview } from '../../store/preview';
import { useRadio } from '../../store/radio';
import { useUi } from '../../store/ui';
import { Prose, Reception } from '../album/Reception';
import { Cover } from '../Cover';
import { SourceLink } from '../Rows';
import { SeekBar, SignalDot, Transport, VolumeControl, ZonePicker } from './parts';

const DitherBackdrop = lazy(() => import('../DitherBackdrop').then((m) => ({ default: m.DitherBackdrop })));

/** Backdrop colour: the dither hue nearest the cover's colour, else the user's Dither pick, else purple. */
function backdropColour(tint: string, ambient: string): DitherColour {
  const fromCover = ditherHueOf(tint);
  if (fromCover) return fromCover;
  if (ambient === 'dither') return 'red';
  if (ambient.startsWith('dither-')) return ambient.slice(7) as DitherColour;
  return 'purple';
}

/** The album's artist notes, the one about the playing song first. */
function SongNotes({ notes, trackId, trackTitle }: { notes: AlbumDetails['artistNotes']; trackId: string; trackTitle: string }) {
  const open = usePreview((p) => p.open);
  const sorted = [...notes].sort((a, b) => Number(b.trackId === trackId) - Number(a.trackId === trackId));
  return (
    <div className="notes">
      {sorted.map((n, i) => {
        const label = n.trackId === trackId ? trackTitle : n.trackId ? 'Another song on this album' : 'About the album';
        return (
          <article key={i} className="note">
            <header className="note__head"><span className="note__track note__track--album">{label}</span></header>
            <Prose text={n.value} lines={8} />
            <SourceLink source={n.source} url={n.url} onPreview={() => open(textPreview(n.verifiedArtist ? 'In the artist’s words' : 'Artist notes', label, n))} />
          </article>
        );
      })}
    </div>
  );
}

export function NowPlaying() {
  const open = useUi((s) => s.nowPlayingOpen);
  const setOpen = useUi((s) => s.setNowPlayingOpen);
  const setQueue = useUi((s) => s.setQueueOpen);
  const queue = usePlayer((s) => s.state.queue);
  const index = usePlayer((s) => s.state.index);
  const nowPlaying = usePlayer((s) => s.state.nowPlaying);
  const command = usePlayer((s) => s.command);
  const cur = queue[index];
  const desktop = useIsDesktop();
  const tint = useCoverColor(cur?.album);
  const ambient = useUi((s) => s.ambient);
  const openPreview = usePreview((s) => s.open);
  const { steps, tone } = useSignalPath();
  const live = isLiveTrack(cur?.track);
  const meta = cur && live ? liveMeta({ nowPlaying }, cur) : null;
  const reason = useRadio((s) => (cur ? s.reasons[cur.track.id] : undefined));
  const liveSub = meta ? [meta.artist, meta.title !== meta.station ? meta.station : ''].filter(Boolean).join(' · ') : '';
  const artSrc = live ? cur?.album.coverUrl ?? null : undefined;
  const [dy, setDy] = useState(0);
  const touch = useRef<{ y: number; x: number; ok: boolean } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const details = useQuery({
    queryKey: ['details', cur?.album.id],
    queryFn: () => api.details(cur!.album.id),
    enabled: open && !!cur && !live,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const firstArtist = cur && !live ? cur.track.artists[0] : undefined;
  const artistInfo = useQuery({
    queryKey: ['artist-info', firstArtist?.id],
    queryFn: () => discoverApi.artistInfo(firstArtist!.id),
    enabled: open && !!firstArtist,
    staleTime: 10 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, setOpen]);

  if (!open) return null;

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touch.current = { y: t.clientY, x: t.clientX, ok: (bodyRef.current?.scrollTop ?? 0) <= 0 };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    const s = touch.current;
    if (!t || !s || !s.ok) return;
    const d = t.clientY - s.y;
    if (d > 0 && Math.abs(d) > Math.abs(t.clientX - s.x)) setDy(d);
  };
  const onTouchEnd = () => {
    if (dy > 110) setOpen(false);
    setDy(0);
    touch.current = null;
  };

  const d = details.data;
  const hasReview = !!d && (!!d.reception || d.scores.length > 0 || d.quotes.length > 0);
  const bio = artistInfo.data?.bio;
  const upNext = queue.slice(index + 1, index + 4);
  const title = meta?.title ?? cur?.track.title ?? 'Nothing playing';

  return (
    <div
      className="np"
      role="dialog"
      aria-label="Now Playing"
      style={{ transform: dy ? `translateY(${dy}px)` : undefined, transition: dy ? 'none' : undefined, ['--tint' as string]: tint }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="np__bg np__bg--dither" aria-hidden>
        <Suspense fallback={null}><DitherBackdrop colour={backdropColour(tint, ambient)} /></Suspense>
        <div className="np__bgwash" />
      </div>

      <header className="np__top">
        <button className="btn-icon btn-icon--lg" aria-label="Close Now Playing" onClick={() => setOpen(false)}><ChevronDown size={26} /></button>
        <div className="np__topcenter">
          <span className="eyebrow">Now playing</span>
          {cur && (meta ? (
            <span className="np__topalbum">{meta.station}</span>
          ) : (
            <Link to={`/album/${encId(cur.album.id)}`} className="np__topalbum" onClick={() => setOpen(false)}>{cur.album.title}</Link>
          ))}
        </div>
        <div className="np__topright">
          {cur && !live && (
            <button
              className="btn-icon btn-icon--lg"
              aria-label="Add to playlist"
              title="Add to playlist"
              onClick={() => usePlaylistUi.getState().openPicker({ title: 'Add to playlist', what: `${cur.track.title} · ${cur.track.artists.map((a) => a.name).join(', ')}`, resolve: () => [{ track: cur.track, album: cur.album }] })}
            ><ListPlus size={22} /></button>
          )}
          <ZonePicker placement="bottom-end" compact={!desktop} />
          {!desktop && (
            <button className="btn-icon btn-icon--lg" aria-label="Queue" onClick={() => { setOpen(false); setQueue(true); }}><ListMusic size={22} /></button>
          )}
        </div>
      </header>

      <div className="np__body" ref={bodyRef}>
        <div className="np__main">
        <div className="np__art">
          {cur ? <Cover album={cur.album} size={600} eager className="np__cover" sizes="min(60vh, 50vw)" src={artSrc} /> : <div className="cover np__cover" />}
        </div>

        <div className="np__panel">
          {meta && <span className="livepill"><i />LIVE</span>}
          <h1 className="np__title">{title}</h1>
          {cur && (meta ? (
            liveSub ? <p className="np__sub">{liveSub}</p> : null
          ) : (
            <p className="np__sub">
              {cur.track.artists.map((a, i) => (
                <span key={a.id}>{i > 0 && ', '}<Link className="link link--strong" to={`/artist/${encId(a.id)}`} onClick={() => setOpen(false)}>{a.name}</Link></span>
              ))}
              <span className="dim"> · </span>
              <Link className="link" to={`/album/${encId(cur.album.id)}`} onClick={() => setOpen(false)}>{cur.album.title}</Link>
            </p>
          ))}
          {reason && <p className="np__reason">Radio pick — {reason}</p>}

          <SeekBar className="seek--np" buckets={800} />
          <div className="np__transport"><Transport big /></div>
          <div className="np__vol"><VolumeControl /></div>

          <div className="np__signal">
            <SignalDot withLabel placement="top-start" />
            {steps.length > 0 && <span className={`np__path np__path--${tone}`}>{steps.join(' → ')}</span>}
          </div>

          {upNext.length > 0 && (
            <section className="np__sec">
              <h2 className="eyebrow">Up next</h2>
              <ul className="np__next">
                {upNext.map((q, i) => {
                  const qLive = isLiveTrack(q.track);
                  return (
                    <li key={q.queueId}>
                      <button onClick={() => void command({ type: 'jump', index: index + 1 + i })}>
                        <Cover album={q.album} sizes="40px" src={qLive ? q.album.coverUrl ?? null : undefined} />
                        <span className="np__nexttxt"><b>{q.track.title}</b><span>{qLive ? 'Internet radio · live' : q.track.artists.map((a) => a.name).join(', ')}</span></span>
                        <span className="np__nextdur">{qLive ? <span className="livepill livepill--sm"><i />LIVE</span> : formatDuration(q.track.durationMs)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

        </div>
        </div>

        {cur && !live && (details.isLoading || hasReview || d?.background || (d?.artistNotes.length ?? 0) > 0 || bio) && (
          <div className="np__more">
            {details.isLoading && (
              <section className="np__sec">
                <h2 className="eyebrow">Critical reception</h2>
                <p className="muted">Looking up reviews…</p>
              </section>
            )}
            {d && hasReview && (
              <section className="np__sec" id="np-review">
                <h2 className="eyebrow">Critical reception</h2>
                <Reception details={d} />
              </section>
            )}
            {d && (d.artistNotes.length > 0 || d.background) && (
              <section className="np__sec">
                <h2 className="eyebrow">About this album</h2>
                {d.artistNotes.length > 0 && <SongNotes notes={d.artistNotes} trackId={cur.track.id} trackTitle={cur.track.title} />}
                {d.background && (
                  <div className="bg">
                    {d.artistNotes.length > 0 && <h3 className="eyebrow about__sub">Background</h3>}
                    <Prose text={d.background.value} lines={9} />
                    <SourceLink source={d.background.source} url={d.background.url} onPreview={() => openPreview(textPreview('Background', cur.album.title, d.background!))} />
                  </div>
                )}
              </section>
            )}
            {bio && firstArtist && (
              <section className="np__sec">
                <h2 className="eyebrow">About {firstArtist.name}</h2>
                <div className="bg">
                  <Prose text={bio.value} lines={6} />
                  <SourceLink source={bio.source} url={bio.url} onPreview={() => openPreview(textPreview('Biography', firstArtist.name, bio))} />
                </div>
              </section>
            )}
            <Link className="link np__morelink" to={`/album/${encId(cur.album.id)}`} onClick={() => setOpen(false)}>Open the album page →</Link>
          </div>
        )}
      </div>
    </div>
  );
}
