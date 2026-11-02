import { ListMusic } from 'lucide-react';
import { Link } from 'react-router-dom';
import { encId } from '../../lib/format';
import { currentItem, usePlayer } from '../../store/player';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';
import { SeekBar, SignalDot, Transport, VolumeControl, ZonePicker } from './parts';

export function NowPlayingBar() {
  const state = usePlayer((s) => s.state);
  const cur = currentItem(state);
  const setNp = useUi((s) => s.setNowPlayingOpen);
  const queueOpen = useUi((s) => s.queueOpen);
  const setQueue = useUi((s) => s.setQueueOpen);
  return (
    <footer className="npbar">
      <div className="npbar__now">
        {cur ? (
          <>
            <button className="npbar__art" aria-label="Open Now Playing" onClick={() => setNp(true)}>
              <Cover album={cur.album} sizes="56px" />
            </button>
            <div className="npbar__txt">
              <Link to={`/album/${encId(cur.album.id)}`} className="npbar__title" title={cur.track.title}>{cur.track.title}</Link>
              <div className="npbar__sub">
                {cur.track.artists.map((a, i) => (
                  <span key={a.id}>{i > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>
                ))}
                <span className="dim"> · </span>
                <Link to={`/album/${encId(cur.album.id)}`} className="link">{cur.album.title}</Link>
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
