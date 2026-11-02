import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Avatar } from '../components/album/Credits';
import { Empty } from '../components/Rows';
import { useIsDesktop } from '../hooks/useMedia';
import { encId, plural } from '../lib/format';
import { LibraryTabs } from './Albums';

/** No artists-list endpoint in the contract yet: derive artists from the album list. */
export default function Artists() {
  const desktop = useIsDesktop();
  const q = useQuery({ queryKey: ['albums', 'for-artists'], queryFn: () => api.albums({ sort: 'artist', limit: 1000 }) });
  const map = new Map<string, { id: string; name: string; n: number }>();
  for (const a of q.data?.items ?? []) {
    const e = map.get(a.artist.id);
    if (e) e.n++; else map.set(a.artist.id, { id: a.artist.id, name: a.artist.name, n: 1 });
  }
  const list = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="page page--artists">
      {!desktop && <LibraryTabs active="artists" />}
      <header className="libhead"><div><h1 className="pagehead__title">Artists</h1><p className="pagehead__sub">{q.data ? plural(list.length, 'artist') : ' '}</p></div></header>
      {q.isError ? <Empty title="Could not load artists" /> : (
        <div className="artgrid">
          {list.map((a) => (
            <Link key={a.id} to={`/artist/${encId(a.id)}`} className="artcard">
              <Avatar name={a.name} id={a.id} size={132} />
              <b>{a.name}</b>
              <span>{plural(a.n, 'album')}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
