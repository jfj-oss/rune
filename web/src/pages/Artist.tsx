import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { BookOpen, MoreHorizontal, Play, Radio, Shuffle } from 'lucide-react';
import { useParams, Link } from 'react-router-dom';
import { api, coverSrc } from '../api';
import { AlbumCard, CardSkeleton } from '../components/AlbumCard';
import { Avatar } from '../components/album/Credits';
import { MenuItem, Popover } from '../components/Popover';
import { Prose } from '../components/album/Reception';
import { Cover } from '../components/Cover';
import { PlayStats } from '../components/discover/PlayStats';
import { MobileBack } from '../components/MobileBack';
import { Empty, QuietNote, SectionHead, SourceLink } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { usePlay } from '../hooks/usePlay';
import { groupDiscography } from '../lib/discover';
import { encId, plural } from '../lib/format';
import { textPreview } from '../lib/previews';
import { startRadio } from '../lib/radio';
import { usePreview } from '../store/preview';

export default function ArtistPage() {
  const id = decodeURIComponent(useParams().id ?? '');
  const q = useQuery({ queryKey: ['artist', id], queryFn: () => api.artist(id) });
  const info = useQuery({
    queryKey: ['artist-info', id],
    queryFn: () => discoverApi.artistInfo(id),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const discog = useQuery({
    queryKey: ['discography', id],
    queryFn: () => discoverApi.discography(id),
    staleTime: 5 * 60_000,
  });
  const { playAlbums } = usePlay();
  // the photo only counts once it has really loaded (banner or round avatar); until then / if it fails, the covers mosaic shows
  const [banner, setBanner] = useState<{ src: string; ok: boolean } | null>(null);
  const [avatarPhotoOf, setAvatarPhotoOf] = useState<string | null>(null);
  const openPreview = usePreview((s) => s.open);
  if (q.isError) return <div className="page"><Empty title="Artist not found" /></div>;
  const a = q.data;
  if (!a) return <div className="page"><div className="ahero"><div className="skel skel--title shimmer" style={{ marginTop: 120 }} /></div></div>;

  const bio = a.bio ?? info.data?.bio;
  const heroImage = a.imageUrl ?? info.data?.imageUrl;
  const credit = info.data?.imageCredit;
  const mosaic = [...new Map(a.albums.concat(a.appearsOn).map((x) => [x.id, x])).values()].slice(0, 4);
  const bannerOk = !!heroImage && banner?.src === heroImage && banner.ok;
  const hasPhoto = bannerOk || avatarPhotoOf === a.id;
  const ids = a.albums.map((x) => x.id);
  const hasLocal = a.albums.some((x) => x.source === 'local');
  const sections = groupDiscography(discog.data?.releaseGroups ?? []);
  const albumById = new Map(a.albums.map((x) => [x.id, x]));
  const ownedInDiscography = sections.reduce((n, s) => n + s.items.filter((g) => g.owned).length, 0);

  return (
    <div className="page page--artist">
      <section className="arthero">
        <div className="arthero__bg" aria-hidden>
          {mosaic.length > 0 && (
            <div className={`arthero__mosaic arthero__mosaic--${mosaic.length}${bannerOk ? ' is-out' : ''}`}>{mosaic.map((m) => <img key={m.id} src={coverSrc(m, 200)} alt="" />)}</div>
          )}
          {heroImage && (
            <img
              className={`arthero__img${bannerOk ? ' is-in' : ''}`} src={heroImage} alt=""
              onLoad={() => setBanner({ src: heroImage, ok: true })} onError={() => setBanner({ src: heroImage, ok: false })}
            />
          )}
          <div className={`arthero__wash${bannerOk ? '' : ' arthero__wash--covers'}`} />
        </div>
        <MobileBack />
        <div className="arthero__inner">
          <Avatar key={a.id} name={a.name} id={a.id} size={96} onPhoto={(shown) => setAvatarPhotoOf(shown ? a.id : null)} />
          <div>
            <span className="eyebrow">Artist</span>
            <h1 className="arthero__name">{a.name}</h1>
            <p className="arthero__meta">{plural(a.albums.length, 'album')}{a.appearsOn.length ? ` · appears on ${a.appearsOn.length}` : ''}</p>
            {hasPhoto && credit ? (
              <p className="arthero__credit">
                Photo: {credit.author ? <a href={credit.url} target="_blank" rel="noopener noreferrer">{credit.author}</a> : 'Unknown'}
                {credit.license ? ` · ${credit.license}` : ''}
              </p>
            ) : null}
            {ids.length > 0 && (
              <div className="ahero__actions">
                <button className="btn btn--primary" onClick={() => void playAlbums(ids)}><Play size={18} fill="currentColor" /> Play</button>
                <button className="btn" onClick={() => void playAlbums(ids, { shuffle: true })}><Shuffle size={17} /> Shuffle</button>
                {hasLocal && (
                  <Popover
                    placement="bottom-start"
                    trigger={({ toggle }) => <button className="btn btn--icon" aria-label="More actions" onClick={toggle}><MoreHorizontal size={20} /></button>}
                  >
                    {(close) => (
                      <div role="menu" className="menu">
                        <MenuItem icon={<Radio size={16} />} onClick={() => { close(); void startRadio('artist', a.id); }}>Start radio</MenuItem>
                      </div>
                    )}
                  </Popover>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="abody">
        {bio ? (
          <section className="asec">
            <SectionHead title="Biography" />
            <div className="bg">
              <Prose text={bio.value} lines={6} />
              <SourceLink source={bio.source} url={bio.url} onPreview={() => openPreview(textPreview('Biography', a.name, bio))} />
            </div>
          </section>
        ) : (
          <section className="asec asec--quiet"><QuietNote icon={<BookOpen size={17} />}>No biography found for this artist.</QuietNote></section>
        )}

        <section className="asec">
          <SectionHead title="Your plays" />
          <PlayStats kind="artist" id={a.id} />
        </section>

        {discog.isLoading && sections.length === 0 ? (
          <section className="asec">
            <SectionHead title="Discography" />
            <div className="discog">{Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} />)}</div>
          </section>
        ) : sections.length > 0 ? (
          sections.map((sec) => (
            <section className="asec" key={sec.id}>
              <SectionHead
                title={sec.label}
                action={<span className="sechead__count">{ownedInDiscography > 0 ? `${sec.items.filter((g) => g.owned).length} in library · ` : ''}{sec.items.length}</span>}
              />
              <div className="discog">
                {sec.items.map((g) => {
                  const owned = g.owned && g.albumIds.length > 0;
                  const album = g.albumIds.map((aid) => albumById.get(aid)).find(Boolean);
                  if (owned && album) {
                    return (
                      <div key={g.mbReleaseGroupId} className="discog__item">
                        <AlbumCard album={album} />
                        {g.albumIds.length > 1 ? <span className="discog__note">{plural(g.albumIds.length, 'version')} in library</span> : null}
                      </div>
                    );
                  }
                  if (owned) {
                    const first = g.albumIds[0] as string;
                    return (
                      <Link key={g.mbReleaseGroupId} to={`/album/${encId(first)}`} className="discog__item">
                        <div className="card__art"><Cover album={{ id: first, title: g.title }} sizes="180px" /></div>
                        <span className="card__title">{g.title}</span>
                        <span className="card__sub">{g.year ?? ''}</span>
                      </Link>
                    );
                  }
                  return (
                    <div key={g.mbReleaseGroupId} className="discog__item is-missing" aria-label={`${g.title} — not in library`}>
                      <div className="card__art"><Cover album={{ id: g.mbReleaseGroupId, title: g.title }} sizes="180px" /></div>
                      <span className="card__title">{g.title}</span>
                      <span className="card__sub">{g.year ?? ''}{g.type && g.type !== sec.label.replace(/s$/, '') ? ` · ${g.type}` : ''}</span>
                      <span className="discog__tag">Not in library</span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        ) : a.albums.length > 0 ? (
          <section className="asec">
            <SectionHead title="Albums" />
            <div className="grid grid--lib">{a.albums.map((x) => <AlbumCard key={x.id} album={x} />)}</div>
          </section>
        ) : null}

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
