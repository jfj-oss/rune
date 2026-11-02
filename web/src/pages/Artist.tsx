import { useQuery } from '@tanstack/react-query';
import { Play, Shuffle } from 'lucide-react';
import { useParams, Link } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { AlbumCard } from '../components/AlbumCard';
import { Avatar } from '../components/album/Credits';
import { MobileBack } from '../components/MobileBack';
import { Prose } from '../components/album/Reception';
import { Empty, SectionHead, SourceLink } from '../components/Rows';
import { usePlay } from '../hooks/usePlay';
import { encId, plural } from '../lib/format';

export default function ArtistPage() {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['artist', id], queryFn: () => api.artist(id) });
  const { playAlbums } = usePlay();
  if (q.isError) return <div className="page"><Empty title="Artist not found" /></div>;
  const a = q.data;
  if (!a) return <div className="page"><div className="ahero"><div className="skel skel--title shimmer" style={{ marginTop: 120 }} /></div></div>;
  const mosaic = a.albums.concat(a.appearsOn).slice(0, 6);
  const ids = a.albums.map((x) => x.id);
  return (
    <div className="page page--artist">
      <section className="arthero">
        <div className="arthero__bg" aria-hidden>
          {a.imageUrl ? <img className="arthero__img" src={a.imageUrl} alt="" /> : (
            <div className="arthero__mosaic">{mosaic.map((m) => <img key={m.id} src={coverSrc(m, 200)} alt="" />)}</div>
          )}
          <div className="arthero__wash" />
        </div>
        <MobileBack />
        <div className="arthero__inner">
          <Avatar name={a.name} id={a.id} size={96} />
          <div>
            <span className="eyebrow">Artist</span>
            <h1 className="arthero__name">{a.name}</h1>
            <p className="arthero__meta">{plural(a.albums.length, 'album')}{a.appearsOn.length ? ` · appears on ${a.appearsOn.length}` : ''}</p>
            {ids.length > 0 && (
              <div className="ahero__actions">
                <button className="btn btn--primary" onClick={() => void playAlbums(ids)}><Play size={18} fill="currentColor" /> Play</button>
                <button className="btn" onClick={() => void playAlbums(ids, { shuffle: true })}><Shuffle size={17} /> Shuffle</button>
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="abody">
        {a.bio ? (
          <section className="asec">
            <SectionHead title="Biography" />
            <div className="bg">
              <Prose text={a.bio.value} lines={6} />
              <SourceLink source={a.bio.source} url={a.bio.url} />
            </div>
          </section>
        ) : (
          <section className="asec asec--quiet"><p className="muted">No biography found for this artist.</p></section>
        )}

        {a.albums.length > 0 && (
          <section className="asec">
            <SectionHead title="Albums" />
            <div className="grid grid--lib">{a.albums.map((x) => <AlbumCard key={x.id} album={x} />)}</div>
          </section>
        )}
        {a.appearsOn.length > 0 && (
          <section className="asec">
            <SectionHead title="Appears on" />
            <div className="grid grid--lib">{a.appearsOn.map((x) => <AlbumCard key={x.id} album={x} />)}</div>
          </section>
        )}
        {a.similar.length > 0 && (
          <section className="asec">
            <SectionHead title="Similar artists" />
            <div className="chips">
              {a.similar.map((s) => <Link key={s.id} to={`/artist/${encId(s.id)}`} className="chip chip--lg"><Avatar name={s.name} id={s.id} size={26} />{s.name}</Link>)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
