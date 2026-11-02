import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Compass, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { DiscoverRow } from '../components/DiscoverRow';
import { Empty } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import { discoverPlayItem, type DiscoverItem, type FeedResponse } from '../lib/discover';
import { plural } from '../lib/format';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { LibraryTabs } from './Albums';

const KEY = ['discover', 'feed'] as const;

export default function Discover() {
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const q = useQuery({ queryKey: KEY, queryFn: () => discoverApi.feed(50, false), staleTime: 5 * 60_000 });

  const state = usePlayer((s) => s.state);
  const playItems = usePlayer((s) => s.playItems);
  const cur = currentItem(state);

  const data = q.data;
  const groups = data?.groups ?? [];

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await discoverApi.feed(50, true);
      qc.setQueryData<FeedResponse>(KEY, next);
    } catch {
      useUi.getState().toast('Could not refresh Discover');
    } finally {
      setRefreshing(false);
    }
  };

  const playGroup = (items: DiscoverItem[], i: number) => {
    void playItems(items.map(discoverPlayItem), i);
  };

  const dismiss = async (item: DiscoverItem) => {
    qc.setQueryData<FeedResponse>(KEY, (old) =>
      old
        ? {
            ...old,
            groups: old.groups
              .map((g) => ({ ...g, items: g.items.filter((x) => x.track.id !== item.track.id) }))
              .filter((g) => g.items.length > 0),
          }
        : old,
    );
    try {
      await discoverApi.dismiss(item.track.id);
      // A radio opened earlier may still hold this song in its client cache.
      void qc.invalidateQueries({ queryKey: ['discover', 'radio'] });
    } catch {
      useUi.getState().toast('Could not dismiss that song');
      void qc.invalidateQueries({ queryKey: KEY });
    }
  };

  return (
    <div className="page page--discover">
      {!desktop && <LibraryTabs active="discover" />}
      <header className="libhead discover__head">
        <div>
          <h1 className="pagehead__title">Discover</h1>
          <p className="pagehead__sub">New songs from Spotify that aren’t in your likes, playlists or library.</p>
        </div>
        <button className="btn discover__refresh" onClick={() => void refresh()} disabled={refreshing || q.isLoading}>
          <RefreshCw size={16} className={refreshing ? 'is-spinning' : undefined} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {data?.notice && <p className="discover__notice" role="status"><Clock size={14} /> {data.notice}</p>}

      {q.isError ? (
        <Empty title="Could not load Discover" icon={<Compass size={28} />}>
          Check that the rune server is running, then try again.
          <br /><br />
          <button className="btn" onClick={() => void q.refetch()}>Try again</button>
        </Empty>
      ) : q.isLoading ? (
        <DiscoverSkeleton />
      ) : data?.status === 'rate_limited' ? (
        <div className="discover__limit" role="status">
          <Clock size={28} />
          <div>
            <h2>Spotify is taking a break</h2>
            <p>{data.message ?? 'Spotify is rate-limiting rune — try again later.'}</p>
            <small>Discover shares a small request budget, so a busy hour never locks the app out for a day.</small>
          </div>
        </div>
      ) : data?.status === 'unavailable' ? (
        <Empty title="Discover is unavailable" icon={<Compass size={28} />}>
          {data.message ?? 'Could not reach Spotify right now. Try again in a moment.'}
        </Empty>
      ) : groups.length === 0 ? (
        <Empty title="Nothing new right now" icon={<Sparkles size={28} />}>
          Everything similar is already in your likes, playlists or library. Try again later, or open a song radio from any track.
        </Empty>
      ) : (
        groups.map((group, gi) => (
          <section className="section discover__group" key={`${group.title}:${gi}`} aria-labelledby={`dg-${gi}`}>
            <div className="discover__grouphead">
              <h2 id={`dg-${gi}`}>{group.title}</h2>
              <span>{plural(group.items.length, 'song')} you don’t have</span>
            </div>
            <ul className="discover__list">
              {group.items.map((item, i) => (
                <DiscoverRow
                  key={item.track.id}
                  item={item}
                  playing={cur?.track.id === item.track.id}
                  isPlaying={state.status === 'playing'}
                  onPlay={() => playGroup(group.items, i)}
                  onDismiss={() => void dismiss(item)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function DiscoverSkeleton() {
  return (
    <div aria-label="Loading Discover" role="status">
      {[0, 1, 2].map((g) => (
        <section className="section discover__group" key={g}>
          <div className="discover__grouphead">
            <span className="skel shimmer" style={{ width: 230, height: 20 }} />
            <span className="skel shimmer" style={{ width: 100, height: 12 }} />
          </div>
          <ul className="discover__list">
            {Array.from({ length: 4 }, (_, i) => (
              <li className="drow drow--skel" key={i}>
                <span className="skel shimmer" style={{ width: 44, height: 44, borderRadius: 6 }} />
                <span className="drow__skeltxt">
                  <span className="skel shimmer" style={{ width: '42%', height: 13 }} />
                  <span className="skel shimmer" style={{ width: '28%', height: 11 }} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
