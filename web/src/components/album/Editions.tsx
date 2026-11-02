import type { Album } from '@liner/shared';
import { CalendarDays, Library } from 'lucide-react';
import { formatShortDate, type AlbumEditions } from '../../lib/discover';
import { plural } from '../../lib/format';
import { AlbumCard } from '../AlbumCard';
import { SectionHead } from '../Rows';

/**
 * The "About" facts for an album: original release date / type, every known
 * edition (with the one you own highlighted) and other versions in the library.
 */
export function AboutMeta({ editions, loading }: { album: Album; editions?: AlbumEditions; loading: boolean }) {
  if (loading && !editions) {
    return (
      <div className="aboutmeta" aria-live="polite">
        <div className="skel skel--line shimmer" style={{ width: 240 }} />
        <div className="skel skel--line shimmer" style={{ width: 420, maxWidth: '100%' }} />
      </div>
    );
  }
  if (!editions) return null;

  const type = editions.releaseGroupType;
  const secondary = editions.secondaryTypes.filter((t) => t.toLowerCase() !== (type ?? '').toLowerCase());
  const hasFacts = !!editions.originalReleaseDate || !!type || secondary.length > 0 || editions.editions.length > 0;
  const hasAnything = hasFacts || editions.otherVersionsInLibrary.length > 0;
  if (!hasAnything) return null;

  return (
    <div className="aboutmeta">
      {hasFacts && (
        <div className="facts">
          {editions.originalReleaseDate ? (
            <div className="fact">
              <span className="fact__k">Originally released</span>
              <span className="fact__v">{formatShortDate(editions.originalReleaseDate)}</span>
            </div>
          ) : null}
          {type ? (
            <div className="fact">
              <span className="fact__k">Release type</span>
              <span className="fact__v">{type}{secondary.length > 0 ? ` · ${secondary.join(' · ')}` : ''}</span>
            </div>
          ) : null}
          {editions.editions.length > 0 ? (
            <div className="fact">
              <span className="fact__k">Editions</span>
              <span className="fact__v">{plural(editions.editions.length, 'known release')}</span>
            </div>
          ) : null}
        </div>
      )}

      {editions.editions.length > 0 && (
        <div className="editions">
          <div className="editions__scroll">
            <table className="editions__table">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Released</th>
                  <th scope="col">Country</th>
                  <th scope="col">Label</th>
                  <th scope="col">Catalogue</th>
                  <th scope="col">Format</th>
                  <th scope="col" className="is-r">Tracks</th>
                </tr>
              </thead>
              <tbody>
                {editions.editions.map((e) => (
                  <tr key={e.mbReleaseId} className={e.isThisOne ? 'is-this' : undefined}>
                    <td className="editions__title">
                      <span>{e.title}</span>
                      {e.isThisOne && <span className="badge editions__this">This one</span>}
                    </td>
                    <td>{e.date ? formatShortDate(e.date) : '—'}</td>
                    <td>{e.country ?? '—'}</td>
                    <td>{e.label ?? '—'}</td>
                    <td className="editions__cat">{e.catalogNumber ?? '—'}</td>
                    <td>{e.format ?? '—'}</td>
                    <td className="is-r">{e.trackCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editions.otherVersionsInLibrary.length > 0 && (
        <div className="otherversions">
          <SectionHead title="Other versions in your library" action={<span className="sechead__count"><Library size={14} /> {plural(editions.otherVersionsInLibrary.length, 'version')}</span>} />
          <div className="grid grid--lib">
            {editions.otherVersionsInLibrary.map((a) => <AlbumCard key={a.id} album={a} />)}
          </div>
        </div>
      )}

      {editions.originalReleaseDate ? (
        <p className="sourceline"><CalendarDays size={13} /> Dates and editions from MusicBrainz.</p>
      ) : null}
    </div>
  );
}
