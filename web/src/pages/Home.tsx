import { useQueries, useQuery } from '@tanstack/react-query';
import { Shuffle } from 'lucide-react';
import { api } from '../api';
import { browseApi } from '../browseApi';
import { AlbumCard, CardSkeleton } from '../components/AlbumCard';
import { HScroll, SectionHead } from '../components/Rows';
import { plural } from '../lib/format';
import { Link } from 'react-router-dom';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const added = useQuery({ queryKey: ['albums', 'home-added'], queryFn: () => api.albums({ sort: 'added', limit: 16 }) });
  const spotify = useQuery({ queryKey: ['albums', 'home-spotify'], queryFn: () => api.albums({ sort: 'added', source: 'spotify', limit: 16 }) });

  // Listening history comes from the server (mock mode serves fixture history through the same calls).
  const recent = useQuery({ queryKey: ['history', 'recent'], queryFn: () => browseApi.historyRecent(12), staleTime: 0, refetchOnMount: 'always' });
  const redis = useQuery({ queryKey: ['history', 'rediscover'], queryFn: () => browseApi.historyRediscover(8, 90), staleTime: 5 * 60_000 });
  const albumQueries = (ids: string[]) => ids.map((id) => ({ queryKey: ['album', id], queryFn: () => api.album(id), staleTime: 60_000 }));
  const played = useQueries({ queries: albumQueries((recent.data ?? []).map((r) => r.albumId)) });
  const rediscoverQs = useQueries({ queries: albumQueries((redis.data ?? []).map((r) => r.albumId)) });
  const recentlyPlayed = played.flatMap((q) => (q.data ? [q.data] : []));
  const rediscover = rediscoverQs.flatMap((q) => (q.data ? [q.data] : []));

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

      {(redis.isLoading || rediscover.length > 0) && <section className="section">
        <SectionHead title="Rediscover" action={<Link to="/albums?sort=title" className="sechead__link"><Shuffle size={13} /> Not played in 90 days</Link>} />
        <div className="grid grid--home">
          {rediscover.length ? rediscover.map((a) => <AlbumCard key={a.id} album={a} />) : redis.isLoading ? Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />) : null}
        </div>
      </section>}
    </div>
  );
}
