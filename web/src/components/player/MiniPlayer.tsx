import { Pause, Play } from 'lucide-react';
import { usePosition } from '../../hooks/usePosition';
import { currentItem, usePlayer } from '../../store/player';
import { useUi } from '../../store/ui';
import { Cover } from '../Cover';

export function MiniPlayer() {
  const state = usePlayer((s) => s.state);
  const command = usePlayer((s) => s.command);
  const setNp = useUi((s) => s.setNowPlayingOpen);
  const pos = usePosition(500);
  const cur = currentItem(state);
  if (!cur) return null;
  const playing = state.status === 'playing' || state.status === 'loading';
  const pct = cur.track.durationMs ? Math.min(100, (pos / cur.track.durationMs) * 100) : 0;
  return (
    <div className="mini" role="group" aria-label="Mini player">
      <div className="mini__progress"><i style={{ width: `${pct}%` }} /></div>
      <button className="mini__main" onClick={() => setNp(true)} aria-label="Open Now Playing">
        <Cover album={cur.album} sizes="48px" />
        <span className="mini__txt">
          <b>{cur.track.title}</b>
          <span>{cur.track.artists.map((a) => a.name).join(', ')}</span>
        </span>
      </button>
      <button className="btn-icon btn-icon--lg" aria-label={playing ? 'Pause' : 'Play'} onClick={() => void command({ type: playing ? 'pause' : 'resume' })}>
        {playing ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
      </button>
    </div>
  );
}
