import { useQuery } from '@tanstack/react-query';
import { ChartColumn, Clock, Disc3, Headphones, Mic2, Play, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/album/Credits';
import { Bars, Sparkline, StatTile } from '../components/discover/Charts';
import { Cover } from '../components/Cover';
import { Empty, SectionHead } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import {
  STATS_PERIODS,
  WEEKDAYS,
  dailySeries,
  formatListening,
  formatShare,
  formatStamp,
  hourLabel,
  type StatsPeriod,
} from '../lib/discover';
import { encId, plural } from '../lib/format';
import { LibraryTabs } from './Albums';

export default function Stats() {
  const desktop = useIsDesktop();
  const [period, setPeriod] = useState<StatsPeriod>('30d');
  const q = useQuery({
    queryKey: ['stats-summary', period],
    queryFn: () => discoverApi.statsSummary(period),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const series = d ? dailySeries(d.byDay, d.from, d.to) : [];

  return (
    <div className="page page--stats">
      {!desktop && <LibraryTabs active="stats" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">Stats</h1>
          <p className="pagehead__sub">
            {q.isLoading || !d ? ' ' : d.from ? `${formatStamp(d.from)} – ${formatStamp(d.to)}` : 'All time'}
          </p>
        </div>
      </header>

      <div className="seg stats__period" role="group" aria-label="Stats period">
        {STATS_PERIODS.map((p) => (
          <button key={p.id} className={period === p.id ? 'is-active' : ''} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
      </div>

      {q.isError ? (
        <Empty title="Could not load your stats" icon={<ChartColumn size={28} />}>Is the rune server running?</Empty>
      ) : !d ? (
        <div className="herogrid" aria-live="polite">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="stathero"><div className="skel skel--title shimmer" style={{ width: '70%' }} /><div className="skel skel--line shimmer" style={{ width: '50%' }} /></div>
          ))}
        </div>
      ) : (
        <>
          <div className="herogrid">
            <StatTile icon={<Clock size={18} />} label="Listening time" value={formatListening(d.totalMs)} />
            <StatTile icon={<Play size={18} />} label="Plays" value={d.plays.toLocaleString('en-US')} />
            <StatTile icon={<Disc3 size={18} />} label="Albums" value={d.distinctAlbums.toLocaleString('en-US')} />
            <StatTile icon={<Mic2 size={18} />} label="Artists" value={d.distinctArtists.toLocaleString('en-US')} />
          </div>

          <section className="statsblock">
            <SectionHead
              title="Listening over time"
              action={<span className="sechead__count"><Headphones size={14} /> {formatListening(d.totalMs)}</span>}
            />
            <div className="stats__panel">
              <Sparkline points={series} label="Listening over time" />
            </div>
          </section>

          <div className="statscols">
            <div className="statscol">
              <section className="statsblock">
                <SectionHead title="Listening by hour" />
                <div className="stats__panel">
                  <Bars values={d.byHour} labels={d.byHour.map((_, i) => hourLabel(i))} labelEvery={6} ariaLabel="Listening by hour of day" />
                </div>
              </section>

              <section className="statsblock">
                <SectionHead title="Listening by weekday" />
                <div className="stats__panel">
                  <Bars values={d.byWeekday} labels={[...WEEKDAYS]} ariaLabel="Listening by weekday" />
                </div>
              </section>

              <section className="statsblock">
                <SectionHead title="Top albums" action={<span className="sechead__count">{plural(d.topAlbums.length, 'album')}</span>} />
                {d.topAlbums.length === 0 ? <p className="muted secnote">No album plays in this period.</p> : (
                  <div className="toplist">
                    {d.topAlbums.map((a, i) => (
                      <div key={a.albumId} className="toprow">
                        <span className="toprow__rank">{i + 1}</span>
                        <Link to={`/album/${encId(a.albumId)}`} className="toprow__art" tabIndex={-1} aria-hidden><Cover album={{ id: a.albumId, title: a.title }} sizes="48px" /></Link>
                        <div className="toprow__txt">
                          <Link to={`/album/${encId(a.albumId)}`} className="toprow__title">{a.title}</Link>
                          <span className="toprow__sub">{a.artist ?? 'Unknown artist'}</span>
                        </div>
                        <span className="toprow__plays">{plural(a.plays, 'play')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="statsblock">
                <SectionHead title="Top tracks" action={<span className="sechead__count">{plural(d.topTracks.length, 'track')}</span>} />
                {d.topTracks.length === 0 ? <p className="muted secnote">No track plays in this period.</p> : (
                  <div className="toplist">
                    {d.topTracks.map((t, i) => (
                      <div key={t.trackId} className="toprow toprow--track">
                        <span className="toprow__rank">{i + 1}</span>
                        <div className="toprow__txt toprow__txt--track">
                          <span className="toprow__title">{t.title}</span>
                          <Link to={`/album/${encId(t.albumId)}`} className="toprow__sub link">{t.albumTitle ?? 'Unknown album'}{t.artist ? ` · ${t.artist}` : ''}</Link>
                        </div>
                        <span className="toprow__plays">{t.plays}× · {formatListening(t.totalMs)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className="statscol">
              <section className="statsblock">
                <SectionHead title="Top artists" action={<span className="sechead__count">{plural(d.topArtists.length, 'artist')}</span>} />
                {d.topArtists.length === 0 ? <p className="muted secnote">No artist plays in this period.</p> : (
                  <div className="toplist">
                    {d.topArtists.map((a) => (
                      <div key={a.artistId} className="toprow toprow--artist">
                        <Link to={`/artist/${encId(a.artistId)}`} className="toprow__avatar" tabIndex={-1} aria-hidden><Avatar name={a.name} id={a.artistId} size={40} /></Link>
                        <div className="toprow__txt">
                          <Link to={`/artist/${encId(a.artistId)}`} className="toprow__title">{a.name}</Link>
                          <span className="toprow__sub">{plural(a.albumCount, 'album')} · {formatListening(a.totalMs)}</span>
                        </div>
                        <span className="toprow__plays">{plural(a.plays, 'play')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="statsblock">
                <SectionHead title="Top genres" />
                {d.topGenres.length === 0 ? <p className="muted secnote">No genre data for this period.</p> : (
                  <div className="genresbars">
                    {d.topGenres.map((g) => {
                      const share = d.plays > 0 ? (g.plays / d.plays) * 100 : 0;
                      return (
                        <div key={g.genre} className="genrebar">
                          <span className="genrebar__name">{g.genre}</span>
                          <span className="genrebar__val">{formatShare(share)}</span>
                          <span className="genrebar__track" aria-hidden><i style={{ width: `${Math.min(100, share)}%` }} /></span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="statsblock">
                <SectionHead title="New discoveries" action={<span className="sechead__count"><Sparkles size={14} /> {d.newDiscoveries.length}</span>} />
                {d.newDiscoveries.length === 0 ? <p className="muted secnote">Nothing new in this period.</p> : (
                  <div className="discovlist">
                    {d.newDiscoveries.map((n) => (
                      <div key={n.artistId} className="discovrow">
                        <Avatar name={n.name} id={n.artistId} size={36} />
                        <div className="discovrow__txt">
                          <Link to={`/artist/${encId(n.artistId)}`} className="discovrow__name">{n.name}</Link>
                          <span className="discovrow__sub">First played {formatStamp(n.firstPlayedAt)}</span>
                        </div>
                        <span className="toprow__plays">{plural(n.plays, 'play')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="statsblock">
                <SectionHead title="Formats" />
                <div className="stats__panel shares">
                  <div className="share">
                    <div className="share__top"><span>Lossless</span><b>{formatShare(d.formats.lossless)}</b></div>
                    <span className="share__track" aria-hidden><i style={{ width: `${Math.min(100, d.formats.lossless)}%` }} /></span>
                  </div>
                  <div className="share">
                    <div className="share__top"><span>Hi-res</span><b>{formatShare(d.formats.hiRes)}</b></div>
                    <span className="share__track" aria-hidden><i style={{ width: `${Math.min(100, d.formats.hiRes)}%` }} /></span>
                  </div>
                  <p className="sourceline">Share of listening time from lossless and hi-res files.</p>
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
