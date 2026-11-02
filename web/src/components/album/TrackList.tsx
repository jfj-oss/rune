import type { Album } from '@liner/shared';
import { ListEnd, ListStart, MoreHorizontal, Play, Radio, User } from 'lucide-react';
import { Fragment } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { albumItems } from '../../hooks/usePlay';
import { encId, formatDuration } from '../../lib/format';
import { startRadio } from '../../lib/radio';
import { currentItem, usePlayer } from '../../store/player';
import { Eq } from '../Eq';
import { AddToPlaylistItem } from '../AddToPlaylist';
import { MenuItem, Popover } from '../Popover';

export function TrackList({ album }: { album: Album }) {
  const state = usePlayer((s) => s.state);
  const playItems = usePlayer((s) => s.playItems);
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const nav = useNavigate();
  const cur = currentItem(state);
  const items = albumItems(album);
  const multi = new Set(album.tracks.map((t) => t.disc)).size > 1;
  let lastDisc = 0;

  return (
    <div className="tracks" role="table" aria-label="Tracks">
      {items.map((it, i) => {
        const t = it.track;
        const playing = cur?.track.id === t.id && cur.album.id === album.id;
        const differs = t.artists.length !== 1 || t.artists[0]?.id !== album.artist.id;
        const head = multi && t.disc !== lastDisc;
        lastDisc = t.disc;
        return (
          <Fragment key={t.id}>
            {head && <div className="tracks__disc" role="row">Disc {t.disc}</div>}
            <div id={`trk-${t.id}`} className={`trow${playing ? ' is-playing' : ''}`} role="row" onDoubleClick={() => void playItems(items, i)}>
              <button className="trow__num" aria-label={`Play ${t.title}`} onClick={() => void playItems(items, i)}>
                <span className="trow__n">{playing ? <Eq playing={state.status === 'playing'} /> : t.number}</span>
                <Play size={14} fill="currentColor" className="trow__p" />
              </button>
              <div className="trow__title">
                <span className="trow__name" title={t.title}>{t.title}</span>
                {differs && (
                  <span className="trow__artist trow__artist--inline">
                    {t.artists.map((a, k) => <span key={a.id}>{k > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>)}
                  </span>
                )}
              </div>
              <div className="trow__artist trow__artist--col">
                {differs && t.artists.map((a, k) => <span key={a.id}>{k > 0 && ', '}<Link to={`/artist/${encId(a.id)}`} className="link">{a.name}</Link></span>)}
              </div>
              <span className="trow__dur">{formatDuration(t.durationMs)}</span>
              <Popover
                className="trow__menu"
                placement="bottom-end"
                trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${t.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
              >
                {(close) => (
                  <div role="menu" className="menu">
                    <MenuItem icon={<ListStart size={16} />} onClick={() => { close(); void enqueueItems([it], true); }}>Play next</MenuItem>
                    <MenuItem icon={<ListEnd size={16} />} onClick={() => { close(); void enqueueItems([it]); }}>Add to queue</MenuItem>
                    <AddToPlaylistItem close={close} target={{ what: t.title, resolve: () => [it] }} />
                    {t.source === 'local' && <MenuItem icon={<Radio size={16} />} onClick={() => { close(); void startRadio('track', t.id); }}>Start radio</MenuItem>}
                    {t.artists[0] && <MenuItem icon={<User size={16} />} onClick={() => { close(); nav(`/artist/${encId(t.artists[0]!.id)}`); }}>Go to artist</MenuItem>}
                  </div>
                )}
              </Popover>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Scroll to a track row and flash it. */
export function jumpToTrack(trackId: string) {
  const el = document.getElementById(`trk-${trackId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}
