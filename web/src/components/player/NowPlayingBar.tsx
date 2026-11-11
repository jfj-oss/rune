import { ListMusic, MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { encId } from '../../lib/format';
import { isLiveTrack } from '../../lib/listenTypes';
import { liveMeta } from '../../lib/live';
import { currentItem, usePlayer } from '../../store/player';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';
import { LikedHeart } from '../Liked';
import { Popover } from '../Popover';
import { TrackMenuItems, trackMenuHandler } from '../TrackMenu';
import { SeekBar, SignalDot, Transport, VolumeControl, ZonePicker } from './parts';

export function NowPlayingBar() {
  const cur = usePlayer((s) => currentItem(s.state));
  const nowPlaying = usePlayer((s) => s.state.nowPlaying);
  const setNp = useUi((s) => s.setNowPlayingOpen);
  const queueOpen = useUi((s) => s.queueOpen);
  const setQueue = useUi((s) => s.setQueueOpen);
  const live = isLiveTrack(cur?.track);
  const meta = cur && live ? liveMeta({ nowPlaying }, cur) : null;
  const liveSub = meta ? [meta.artist, meta.title !== meta.station ? meta.station : ''].filter(Boolean).join(' · ') : '';
  return (
    <footer className="npbar">
      <div className="npbar__now" onContextMenu={cur && !live ? trackMenuHandler(cur) : undefined}>
        {cur ? (
          <>
            <button className="npbar__art" aria-label="Open Now Playing" onClick={() => setNp(true)}>
              <Cover album={cur.album} sizes="56px" src={live ? cur.album.coverUrl ?? null : undefined} />
            </button>
            <div className="npbar__txt">
              {meta ? (
                <span className="npbar__title" title={meta.title}>{meta.title}</span>
              ) : (
                <div className="npbar__titlerow">
                  <Link to={`/album/${encId(cur.album.id)}`} className="npbar__title" title={cur.track.title}>{cur.track.title}</Link>
                  <LikedHeart track={cur.track} />
                  <Popover
                    placement="top-start"
                    trigger={({ toggle }) => (
                      <button className="btn-icon npbar__more" aria-label={`More for ${cur.track.title}`} title="Add to playlist, radio, album…" onClick={toggle}>
                        <MoreHorizontal size={18} />
                      </button>
                    )}
                  >
                    {(close) => <TrackMenuItems item={cur} close={close} />}
                  </Popover>
                </div>
              )}
              <div className="npbar__sub">
                {meta ? (
                  <>
                    <span className="livepill livepill--sm"><i />LIVE</span>
                    {liveSub && <span className="npbar__livesub">{liveSub}</span>}
                  </>
                ) : (
                  <>
                    {cur.track.artists.map((a, i) => (
                      <span key={a.id}>{i > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>
                    ))}
                    <span className="dim"> · </span>
                    <Link to={`/album/${encId(cur.album.id)}`} className="link">{cur.album.title}</Link>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="npbar__idle">Nothing playing</div>
        )}
      </div>
      <div className="npbar__center">
        <Transport />
        <SeekBar />
      </div>
      <div className="npbar__right">
        <SignalDot />
        <ZonePicker />
        <VolumeControl />
        <button className={`btn-icon${queueOpen ? ' is-on' : ''}`} aria-label="Queue" aria-pressed={queueOpen} onClick={() => setQueue(!queueOpen)}>
          <ListMusic size={20} />
        </button>
      </div>
    </footer>
  );
}
