import { useQueries, useQuery } from '@tanstack/react-query';
import { Shuffle } from 'lucide-react';
import { useMemo } from 'react';
import { api } from '../api';
import { AlbumCard, CardSkeleton } from '../components/AlbumCard';
import { HScroll, SectionHead } from '../components/Rows';
import { usePlayer } from '../store/player';
import { loadLocal } from '../store/ui';
import { plural } from '../lib/format';
import { Link } from 'react-router-dom';

const DAY = 86_400_000;

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const added = useQuery({ queryKey: ['albums', 'home-added'], queryFn: () => api.albums({ sort: 'added', limit: 16 }) });
  const spotify = useQuery({ queryKey: ['albums', 'home-spotify'], queryFn: () => api.albums({ sort: 'added', source: 'spotify', limit: 16 }) });
  const pool = useQuery({ queryKey: ['albums', 'home-pool'], queryFn: () => api.albums({ sort: 'title', source: 'local', limit: 200 }) });

  const ready = usePlayer((s) => s.ready);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => loadLocal<{ id: string; at: number }[]>('rune.played', []), [ready]);
  const recentIds = history.slice(0, 12).map((h) => h.id);
  const played = useQueries({ queries: recentIds.map((id) => ({ queryKey: ['album', id], queryFn: () => api.album(id), staleTime: 60_000 })) });
  const recentlyPlayed = played.flatMap((q) => (q.data ? [q.data] : []));

  const rediscover = useMemo(() => {
    const recent = new Set(history.filter((h) => Date.now() - h.at < 90 * DAY).map((h) => h.id));
    const items = (pool.data?.items ?? []).filter((a) => !recent.has(a.id));
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a.slice(0, 8);
  }, [pool.data, history]);

  const total = added.data?.total;

  return (
    <div className="page page--home">
      <header className="pagehead">
        <h1 className="pagehead__title">{greeting()}</h1>
        <p className="pagehead__sub">{total !== undefined ? `${plural(total, 'album')} in your library` : ' '}</p>
      </header>

      <section className="section">
        <SectionHead title="Recently added" to="/albums" />
        <HScroll>
          {added.data ? added.data.items.map((a, i) => <AlbumCard key={a.id} album={a} width={180} eager={i < 8} />) : Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} width={180} />)}
        </HScroll>
      </section>

      {recentlyPlayed.length > 0 && (
        <section className="section">
          <SectionHead title="Recently played" />
          <HScroll>{recentlyPlayed.map((a) => <AlbumCard key={a.id} album={a} width={180} />)}</HScroll>
        </section>
      )}

      {spotify.data && spotify.data.total > 0 && (
        <section className="section">
          <SectionHead title="From Spotify — your saved albums" to="/albums?source=spotify" />
          <HScroll>{spotify.data.items.map((a) => <AlbumCard key={a.id} album={a} width={180} />)}</HScroll>
        </section>
      )}

      <section className="section">
        <SectionHead title="Rediscover" action={<Link to="/albums?sort=title" className="sechead__link"><Shuffle size={13} /> Not played in 90 days</Link>} />
        <div className="grid grid--home">
          {rediscover.length ? rediscover.map((a) => <AlbumCard key={a.id} album={a} />) : Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}
        </div>
      </section>
    </div>
  );
}
