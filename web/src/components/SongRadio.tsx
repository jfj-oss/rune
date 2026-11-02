import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Play, Radio, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import { discoverPlayItem, type SimilarResponse } from '../lib/discover';
import { useDiscoverUi } from '../store/discoverUi';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { Cover } from './Cover';
import { DiscoverRow } from './DiscoverRow';

/**
 * Song radio: a right-hand sheet on desktop, a bottom sheet on phones. Its
 * rows expose play, + queue, add to playlist and dismiss; "Play all" queues the
 * whole radio.
 */
export function SongRadio() {
  const track = useDiscoverUi((s) => s.radio);
  const close = useDiscoverUi((s) => s.closeRadio);
  const desktop = useIsDesktop();
  const panel = useRef<HTMLElement>(null);
  const qc = useQueryClient();
  const key = ['discover', 'radio', track?.track.id] as const;

  const q = useQuery({
    queryKey: key,
    queryFn: () => discoverApi.similar(track!.track.id, 30),
    enabled: !!track,
    staleTime: 5 * 60_000,
  });

  const playItems = usePlayer((s) => s.playItems);
  const state = usePlayer((s) => s.state);
  const current = state.queue[state.index];

  useEffect(() => {
    if (!track) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A picker/dialog opened from a radio row owns Escape; don't close both.
      if (e.key === 'Escape' && !document.querySelector('.dialog__scrim')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [track, close]);

  if (!track) return null;

  const seedTitle = q.data?.seed?.title ?? track.track.title;
  const seedArtist = q.data?.seed?.artist ?? track.track.artists.map((a) => a.name).join(', ');
  const items = q.data?.items ?? [];
  const playAll = () => { if (items.length) void playItems(items.map(discoverPlayItem), 0); };
  const playAt = (i: number) => { void playItems(items.map(discoverPlayItem), i); };

  const dismiss = async (index: number) => {
    const item = items[index];
    if (!item) return;
    qc.setQueryData<SimilarResponse>(key, (old) =>
      old ? { ...old, items: old.items.filter((x) => x.track.id !== item.track.id) } : old,
    );
    try {
      await discoverApi.dismiss(item.track.id);
      void qc.invalidateQueries({ queryKey: ['discover', 'feed'] });
    } catch {
      useUi.getState().toast('Could not dismiss that song');
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  const body = () => {
    if (q.isError) {
      return (
        <div className="radio__state" role="alert">
          <Radio size={26} />
          <b>Could not load song radio</b>
          <p>Check that the rune server is running, then try again.</p>
          <button className="btn btn--sm" onClick={() => void q.refetch()}>Try again</button>
        </div>
      );
    }
    if (q.isLoading) {
      return <ul className="radio__list" aria-label="Loading song radio">{Array.from({ length: 8 }, (_, i) => <li key={i} className="radio__skel"><span className="skel shimmer" /><span className="skel skel--line shimmer" /></li>)}</ul>;
    }
    if (q.data?.status === 'rate_limited') {
      return (
        <div className="radio__state radio__state--limit" role="status">
          <Clock size={26} />
          <b>Spotify is taking a break</b>
          <p>{q.data.message ?? 'Spotify is rate-limiting rune — try again later.'}</p>
          <small>Discover shares a small request budget so the app does not get locked out.</small>
        </div>
      );
    }
    if (q.data?.status === 'unavailable') {
      return <div className="radio__state" role="status"><Radio size={26} /><b>Radio unavailable</b><p>{q.data.message ?? 'Could not reach Spotify right now.'}</p><button className="btn btn--sm" onClick={() => void q.refetch()}>Try again</button></div>;
    }
    if (items.length === 0) {
      return <div className="radio__state" role="status"><Radio size={26} /><b>No new songs for this one</b><p>Everything similar is already in your likes, playlists or library. Try another track.</p></div>;
    }
    return (
      <ul className="radio__list" aria-label={`Songs similar to ${seedTitle}`}>
        {items.map((item, i) => (
          <DiscoverRow
            key={item.track.id}
            item={item}
            playing={current?.track.id === item.track.id}
            isPlaying={state.status === 'playing'}
            onPlay={() => playAt(i)}
            onDismiss={() => void dismiss(i)}
          />
        ))}
      </ul>
    );
  };

  return createPortal(
    <>
      <div className="radio__scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }} />
      <aside
        ref={panel}
        className={`radio${desktop ? '' : ' radio--sheet'}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Song radio for ${seedTitle}`}
        tabIndex={-1}
      >
        {!desktop && <span className="radio__grip" aria-hidden />}
        <header className="radio__head">
          <div className="radio__top">
            <span className="eyebrow radio__kind"><Radio size={13} /> Song radio</span>
            <button className="btn-icon" aria-label="Close song radio" onClick={close}><X size={19} /></button>
          </div>
          <div className="radio__seed">
            <span className="radio__cover"><Cover album={track.album} sizes="84px" /></span>
            <div className="radio__seedtxt">
              <h2>{seedTitle}</h2>
              <p>{seedArtist}</p>
              <small>Songs on Spotify you don’t have yet</small>
            </div>
          </div>
          <div className="radio__actions">
            <button className="btn btn--primary" disabled={items.length === 0} onClick={playAll}><Play size={17} fill="currentColor" /> Play all</button>
            <span className="radio__count">
              {q.data?.status === 'ok' ? `${items.length} new ${items.length === 1 ? 'song' : 'songs'}` : ' '}
            </span>
          </div>
        </header>
        <div className="radio__body">{body()}</div>
      </aside>
    </>,
    document.body,
  );
}
