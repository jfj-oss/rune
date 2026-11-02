import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlbumCard } from '../components/AlbumCard';
import { Avatar } from '../components/album/Credits';
import { Cover } from '../components/Cover';
import { MobileBack } from '../components/MobileBack';
import { Empty, SectionHead } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { encId, plural } from '../lib/format';

export default function PersonPage() {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['person', id], queryFn: () => discoverApi.person(id) });
  const info = useQuery({
    queryKey: ['artist-info', id],
    queryFn: () => discoverApi.artistInfo(id),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [id]);

  if (q.isError) {
    return (
      <div className="page">
        <Link to="/people" className="backlink"><ChevronLeft size={16} /> People</Link>
        <Empty title="Person not found" icon={<Users size={28} />}>They may not be credited on anything in your library.</Empty>
      </div>
    );
  }
  const p = q.data;
  if (!p) {
    return (
      <div className="page page--person">
        <div className="personhero">
          <div className="avatar shimmer" style={{ width: 112, height: 112 }} />
          <div style={{ flex: 1 }}><div className="skel skel--title shimmer" /><div className="skel skel--line shimmer" style={{ width: '40%' }} /></div>
        </div>
      </div>
    );
  }

  const photo = info.data?.imageUrl && !imgFailed ? info.data.imageUrl : undefined;
  const credit = info.data?.imageCredit;
  const collabs = p.collaborators;

  return (
    <div className="page page--person">
      <MobileBack />
      <Link to="/people" className="backlink"><ChevronLeft size={16} /> People</Link>

      <header className="personhero">
        {photo ? <img className="personhero__photo" src={photo} alt="" onError={() => setImgFailed(true)} /> : <Avatar name={p.name} id={p.id} size={112} />}
        <div className="personhero__txt">
          <span className="eyebrow">Person</span>
          <h1 className="personhero__name">{p.name}</h1>
          <p className="personhero__meta">
            Credited on {plural(p.credits.length, 'album')}
            {p.asArtist.length > 0 ? ` · ${plural(p.asArtist.length, 'album')} as artist` : ''}
          </p>
          {p.roles.length > 0 && (
            <div className="personhero__roles" aria-label="Roles">
              {p.roles.map((r) => (
                <span key={r.role} className="personhero__role">
                  {r.role}<small>{plural(r.count, 'album')}</small>
                </span>
              ))}
            </div>
          )}
          {photo && credit ? (
            <p className="personhero__credit">
              Photo: {credit.author ?? 'Unknown'}{credit.license ? ` · ${credit.license}` : ''}
            </p>
          ) : null}
        </div>
      </header>

      {p.asArtist.length > 0 && (
        <section className="asec">
          <SectionHead title="As artist" action={<span className="sechead__count">{plural(p.asArtist.length, 'album')}</span>} />
          <div className="grid grid--lib">{p.asArtist.map((a) => <AlbumCard key={a.id} album={a} />)}</div>
        </section>
      )}

      <section className="asec">
        <SectionHead title="Credits" action={<span className="sechead__count">{plural(p.credits.length, 'album')}</span>} />
        {p.credits.length === 0 ? (
          <p className="muted secnote">No album credits stored for this person yet.</p>
        ) : (
          <div className="pcredits">
            {p.credits.map((c) => (
              <article key={c.album.id} className="pcredit">
                <Link to={`/album/${encId(c.album.id)}`} className="pcredit__art" tabIndex={-1} aria-hidden>
                  <Cover album={c.album} sizes="56px" />
                </Link>
                <div className="pcredit__txt">
                  <Link to={`/album/${encId(c.album.id)}`} className="pcredit__album">{c.album.title}</Link>
                  <span className="pcredit__by">
                    <Link to={`/artist/${encId(c.album.artist.id)}`} className="link">{c.album.artist.name}</Link>
                    {c.album.year ? <span> · {c.album.year}</span> : null}
                  </span>
                  <span className="pcredit__roles">{c.roles.join(' · ')}</span>
                  {c.tracks && c.tracks.length > 0 ? (
                    <span className="pcredit__tracks">Tracks: {c.tracks.map((t) => t.title).join(', ')}</span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {collabs.length > 0 && (
        <section className="asec">
          <SectionHead title="Often works with" />
          <div className="chips">
            {collabs.map((c) => (
              <Link
                key={c.artist.id}
                to={`/person/${encId(c.artist.id)}`}
                className="chip chip--lg"
                title={`${plural(c.sharedAlbums, 'shared album')} with ${p.name}`}
              >
                <Avatar name={c.artist.name} id={c.artist.id} size={26} />
                {c.artist.name}
                <span className="chip__n">{c.sharedAlbums}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
