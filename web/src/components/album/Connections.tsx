import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { discoverApi } from '../../discoverApi';
import { encId } from '../../lib/format';
import { AlbumCard } from '../AlbumCard';
import { SectionHead } from '../Rows';

/** Albums in the library that share credited people with this one. */
export function Connections({ albumId }: { albumId: string }) {
  const q = useQuery({
    queryKey: ['connections', albumId],
    queryFn: () => discoverApi.connections(albumId),
    staleTime: 60_000,
  });

  if (q.isError) return null;
  if (!q.data || q.data.connections.length === 0) return null;

  return (
    <section className="asec" id="connections">
      <SectionHead title="Connections" action={<span className="sechead__count"><Users size={14} /> {q.data.connections.length}</span>} />
      <p className="secnote">Other albums in your library that share people with this one.</p>
      <div className="connections">
        {q.data.connections.map((c) => {
          const shown = c.people.slice(0, 3);
          const rest = c.people.length - shown.length;
          return (
            <div key={c.album.id} className="conn">
              <AlbumCard album={c.album} />
              <p className="conn__via">
                With{' '}
                {shown.map((p, i) => (
                  <span key={p.artist.id}>
                    {i > 0 ? ', ' : ''}
                    <Link to={`/person/${encId(p.artist.id)}`} title={p.roles.join(', ')}>{p.artist.name}</Link>
                    {p.roles.length > 0 ? <span className="conn__role"> ({p.roles.join(', ')})</span> : null}
                  </span>
                ))}
                {rest > 0 ? <span className="conn__role"> and {rest} more</span> : null}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
