import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Play, Radio, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Cover } from '../components/Cover';
import { Empty } from '../components/Rows';
import { useIsDesktop } from '../hooks/useMedia';
import { listenApi } from '../listenApi';
import type { RadioSearchResult, RadioStation } from '../lib/listenTypes';
import { isLiveTrack } from '../lib/listenTypes';
import { playStation } from '../lib/radio';
import { currentItem, usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { LibraryTabs } from './Albums';

const GENRES = ['jazz', 'ambient', 'classical', 'electronic', 'lofi', 'news'] as const;
const LIMIT = 60;

/** Server search is by name; the directory also has tag/country filters, so merge them. */
async function searchStations(q: string, tag?: string): Promise<RadioSearchResult> {
  const text = q.trim();
  if (!text) return listenApi.stations({ tag, limit: LIMIT, sort: 'votes' });
  const calls = [
    listenApi.stations({ q: text, tag, limit: 40, sort: 'votes' }),
    listenApi.stations({ country: text, tag, limit: 40, sort: 'votes' }),
    // A tag can't be combined with another tag, so only look it up without a chip.
    ...(tag ? [] : [listenApi.stations({ tag: text, limit: 40, sort: 'votes' })]),
  ];
  const settled = await Promise.allSettled(calls);
  const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  if (!ok.length && settled.every((r) => r.status === 'rejected')) throw new Error('radio search failed');
  const seen = new Map<string, RadioStation>();
  for (const s of ok) if (!seen.has(s.id)) seen.set(s.id, s);
  return { items: [...seen.values()].slice(0, 90), total: seen.size };
}

function StationCard({ station, fav, playing, onFav }: { station: RadioStation; fav: boolean; playing: boolean; onFav(s: RadioStation): void }) {
  const tags = station.tags.slice(0, 3).join(' · ') || station.country || 'Internet radio';
  return (
    <article className={`rcard${playing ? ' is-playing' : ''}`}>
      <button className="rcard__main" onClick={() => void playStation(station)} aria-label={`Play ${station.name}`}>
        <span className="rcard__art">
          <Cover album={{ id: station.id, title: station.name }} src={station.logoUrl ?? station.favicon ?? null} sizes="200px" />
          <span className="rcard__shade" aria-hidden><span className="rcard__go"><Play size={20} fill="currentColor" /></span></span>
          {playing && <span className="rcard__live"><span className="livepill"><i />LIVE</span></span>}
        </span>
        <span className="rcard__name" title={station.name}>{station.name}</span>
        <span className="rcard__tags">{tags}</span>
        <span className="rcard__meta">
          {station.country && <span>{station.country}</span>}
          {station.bitrate > 0 && <span>{station.bitrate} kbps</span>}
        </span>
      </button>
      <button
        className={`rcard__fav${fav ? ' is-on' : ''}`}
        aria-label={fav ? `Remove ${station.name} from favourites` : `Add ${station.name} to favourites`}
        aria-pressed={fav}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
        onClick={() => onFav(station)}
      >
        <Heart size={17} fill={fav ? 'currentColor' : 'none'} />
      </button>
    </article>
  );
}

function StationSkeleton() {
  return (
    <div className="rcard rcard--skel" aria-hidden>
      <div className="cover shimmer" />
      <span className="skel skel--line shimmer" />
      <span className="skel skel--line shimmer" style={{ width: '60%' }} />
    </div>
  );
}

export default function RadioPage() {
  const desktop = useIsDesktop();
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const playingId = usePlayer((s) => {
    const cur = currentItem(s.state);
    return cur && isLiveTrack(cur.track) ? cur.track.id : undefined;
  });
  const zoneName = usePlayer((s) => s.zones.find((z) => z.id === s.zone)?.name ?? 'this zone');

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const stationsQ = useQuery({
    queryKey: ['radio', 'stations', q, tag ?? ''],
    queryFn: () => searchStations(q, tag),
    staleTime: 60_000,
  });
  const favQ = useQuery({ queryKey: ['radio', 'favourites'], queryFn: () => listenApi.favourites(), staleTime: 60_000 });

  const favIds = useMemo(() => new Set((favQ.data ?? []).map((s) => s.id)), [favQ.data]);
  const isFav = (s: RadioStation) => overrides[s.id] ?? favIds.has(s.id);
  const items = stationsQ.data?.items ?? [];
  const favs = useMemo(() => (favQ.data ?? []).filter((s) => overrides[s.id] ?? favIds.has(s.id)), [favQ.data, favIds, overrides]);

  const toggleFav = async (station: RadioStation) => {
    const next = !isFav(station);
    setOverrides((o) => ({ ...o, [station.id]: next }));
    try {
      if (next) await listenApi.addFavourite(station.id);
      else await listenApi.removeFavourite(station.id);
      await qc.invalidateQueries({ queryKey: ['radio', 'favourites'] });
      setOverrides((o) => {
        const copy = { ...o };
        delete copy[station.id];
        return copy;
      });
    } catch {
      setOverrides((o) => {
        const copy = { ...o };
        delete copy[station.id];
        return copy;
      });
      toast('Could not update favourites');
    }
  };

  const heading = q
    ? `Results for “${q}”`
    : tag
      ? `${tag[0]!.toUpperCase()}${tag.slice(1)} stations`
      : 'All stations';

  return (
    <div className="page page--radio">
      {!desktop && <LibraryTabs active="radio" />}
      <header className="libhead">
        <div>
          <span className="eyebrow radio__eyebrow"><Radio size={13} /> Internet radio</span>
          <h1 className="pagehead__title">Radio</h1>
          <p className="pagehead__sub">Live stations from the whole world, playing on {zoneName}.</p>
        </div>
      </header>

      <label className="search search--page radio__search">
        <Search size={17} />
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search stations, tags or countries"
          aria-label="Search radio stations"
          autoComplete="off"
          spellCheck={false}
        />
        {text && <button type="button" className="search__clear" aria-label="Clear radio search" onClick={() => { setText(''); setQ(''); }}><X size={15} /></button>}
      </label>

      <div className="rchips chips" role="group" aria-label="Station genres">
        {GENRES.map((g) => (
          <button
            key={g}
            className={`chip chip--btn${tag === g ? ' is-set' : ''}`}
            aria-pressed={tag === g}
            onClick={() => setTag((t) => (t === g ? undefined : g))}
          >{g}</button>
        ))}
      </div>

      {favs.length > 0 && (
        <section className="rsec">
          <div className="sechead">
            <h2 className="eyebrow">Favourites</h2>
            <span className="muted">{favs.length}</span>
          </div>
          <div className="rfavrow">
            {favs.map((s) => (
              <StationCard key={s.id} station={s} fav={isFav(s)} playing={playingId === s.id} onFav={(x) => void toggleFav(x)} />
            ))}
          </div>
        </section>
      )}

      <section className="rsec">
        <div className="sechead">
          <h2 className="eyebrow">{heading}</h2>
          {!stationsQ.isLoading && <span className="muted">{items.length} {items.length === 1 ? 'station' : 'stations'}</span>}
        </div>
        {stationsQ.isError ? (
          <Empty title="Could not load radio stations">
            The radio directory may be unreachable. <button className="link" onClick={() => void stationsQ.refetch()}>Try again</button>.
          </Empty>
        ) : stationsQ.isLoading ? (
          <div className="rgrid">{Array.from({ length: 10 }, (_, i) => <StationSkeleton key={i} />)}</div>
        ) : items.length === 0 ? (
          <Empty title="No stations found">
            {q || tag ? 'Try another name, tag or country.' : 'The radio directory returned no stations. Try again in a moment.'}
          </Empty>
        ) : (
          <div className="rgrid">
            {items.map((s) => (
              <StationCard key={s.id} station={s} fav={isFav(s)} playing={playingId === s.id} onFav={(x) => void toggleFav(x)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
