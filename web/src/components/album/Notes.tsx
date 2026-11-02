import type { Album, AlbumDetails } from '@liner/shared';
import { BadgeCheck } from 'lucide-react';
import { SourceLink } from '../Rows';
import { Prose } from './Reception';
import { jumpToTrack } from './TrackList';

export function ArtistNotes({ notes, album }: { notes: AlbumDetails['artistNotes']; album: Album }) {
  return (
    <div className="notes">
      {notes.map((n, i) => {
        const track = n.trackId ? album.tracks.find((t) => t.id === n.trackId) : undefined;
        return (
          <article key={i} className="note">
            <header className="note__head">
              {track ? <button className="note__track" onClick={() => jumpToTrack(track.id)}>{track.title}</button> : <span className="note__track note__track--album">About the album</span>}
              {n.verifiedArtist && <span className="pill pill--verified"><BadgeCheck size={13} /> Verified artist</span>}
            </header>
            <Prose text={n.value} lines={8} />
            <SourceLink source={n.source} url={n.url} />
          </article>
        );
      })}
    </div>
  );
}
