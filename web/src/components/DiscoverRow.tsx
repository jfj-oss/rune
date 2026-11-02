import { ListMusic, ListPlus, MoreHorizontal, Play, X } from 'lucide-react';
import { usePlayer } from '../store/player';
import { usePlaylistUi } from '../store/playlistUi';
import { discoverPlayItem, type DiscoverItem } from '../lib/newSongs';
import { formatDuration } from '../lib/format';
import { Cover } from './Cover';
import { Eq } from './Eq';
import { Popover } from './Popover';
import { TrackMenuItems, trackMenuHandler } from './TrackMenu';

/**
 * A Discover/radio row: play, queue, add to playlist, dismiss — plus the shared
 * ⋯ menu (with Song radio) and the same menu on right-click.
 */
export function DiscoverRow({
  item,
  playing = false,
  isPlaying = false,
  onPlay,
  onDismiss,
}: {
  item: DiscoverItem;
  playing?: boolean;
  isPlaying?: boolean;
  onPlay(): void;
  onDismiss(): void;
}) {
  const enqueueItems = usePlayer((s) => s.enqueueItems);
  const playItem = discoverPlayItem(item);
  const artist = item.track.artists.map((a) => a.name).join(', ');

  const addToPlaylist = () => {
    usePlaylistUi.getState().openPicker({
      title: 'Add to playlist',
      what: item.track.title,
      resolve: () => [playItem],
    });
  };

  return (
    <li
      className={`drow${playing ? ' is-playing' : ''}`}
      onContextMenu={trackMenuHandler(playItem)}
      onClick={(e) => { if ((e.target as HTMLElement).closest('a,button,.pop,[role="menu"]')) return; onPlay(); }}
    >
      <button className="drow__art" aria-label={`Play ${item.track.title}`} onClick={onPlay}>
        <Cover album={item.album} sizes="44px" />
        <span className="drow__ov">{playing ? <Eq playing={isPlaying} /> : <Play size={15} fill="currentColor" />}</span>
      </button>
      <span className="drow__txt">
        <span className="drow__title" title={item.track.title}>{item.track.title}</span>
        <span className="drow__artist" title={`${artist} · ${item.album.title}`}>{artist} <i>·</i> {item.album.title}</span>
        <span className="drow__reason">{item.reason}</span>
      </span>
      <span className="drow__dur">{formatDuration(item.track.durationMs)}</span>
      <span className="drow__acts">
        <button className="btn-icon" aria-label={`Add ${item.track.title} to queue`} title="Add to queue" onClick={() => void enqueueItems([playItem])}><ListPlus size={17} /></button>
        <button className="btn-icon" aria-label={`Add ${item.track.title} to playlist`} title="Add to playlist" onClick={addToPlaylist}><ListMusic size={17} /></button>
        <button className="btn-icon drow__x" aria-label={`Dismiss ${item.track.title}`} title="Not for me" onClick={onDismiss}><X size={17} /></button>
        <Popover
          placement="bottom-end"
          trigger={({ toggle }) => <button className="btn-icon" aria-label={`More for ${item.track.title}`} onClick={toggle}><MoreHorizontal size={18} /></button>}
        >
          {(close) => <TrackMenuItems item={playItem} close={close} />}
        </Popover>
      </span>
    </li>
  );
}
