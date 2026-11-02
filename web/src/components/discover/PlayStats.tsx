import { useQuery } from '@tanstack/react-query';
import { discoverApi } from '../../discoverApi';
import { dailySeries, formatListening, formatStamp, type AlbumStats } from '../../lib/discover';
import { Sparkline } from './Charts';

type PlaySummary = Pick<AlbumStats, 'plays' | 'totalMs' | 'firstPlayedAt' | 'lastPlayedAt' | 'byDay' | 'from' | 'to'>;

/**
 * "Your plays" for an album or artist: all-time plays, listening time and the
 * first/last time it was played, plus the daily shape underneath.
 */
export function PlayStats({ kind, id }: { kind: 'album' | 'artist'; id: string }) {
  const q = useQuery({
    queryKey: ['play-stats', kind, id],
    queryFn: async (): Promise<PlaySummary | null> =>
      kind === 'album' ? await discoverApi.statsAlbum(id, 'all') : await discoverApi.statsArtist(id, 'all'),
    staleTime: 60_000,
  });

  if (q.isLoading) {
    return (
      <div className="playstats" aria-live="polite">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="ptile"><div className="skel skel--line shimmer" /><div className="skel skel--line shimmer skel--short" /></div>
        ))}
      </div>
    );
  }
  if (q.isError) return <p className="muted secnote">Could not load your listening history.</p>;

  const s = q.data;
  if (!s) return <p className="muted secnote">You haven’t played this yet.</p>;
  if (s.plays === 0) return <p className="muted secnote">No plays recorded yet.</p>;

  const series = dailySeries(s.byDay, s.from, s.to);
  return (
    <>
      <div className="playstats">
        <div className="ptile"><span className="ptile__v">{s.plays.toLocaleString('en-US')}</span><span className="ptile__k">Plays</span></div>
        <div className="ptile"><span className="ptile__v">{formatListening(s.totalMs)}</span><span className="ptile__k">Listening time</span></div>
        <div className="ptile"><span className="ptile__v">{formatStamp(s.firstPlayedAt)}</span><span className="ptile__k">First played</span></div>
        <div className="ptile"><span className="ptile__v">{formatStamp(s.lastPlayedAt)}</span><span className="ptile__k">Last played</span></div>
      </div>
      {series.length > 1 && (
        <div className="playstats__spark">
          <Sparkline points={series} label={kind === 'album' ? 'Plays of this album over time' : 'Plays of this artist over time'} height={88} />
        </div>
      )}
    </>
  );
}
