import { useQuery } from '@tanstack/react-query';
import { Search, Users, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/album/Credits';
import { Empty } from '../components/Rows';
import { discoverApi } from '../discoverApi';
import { useIsDesktop } from '../hooks/useMedia';
import { ROLE_BUCKETS, personInBucket, type RoleBucket } from '../lib/discover';
import { encId, plural } from '../lib/format';
import { LibraryTabs } from './Albums';

export default function People() {
  const desktop = useIsDesktop();
  const q = useQuery({ queryKey: ['people'], queryFn: () => discoverApi.people(), staleTime: 60_000 });
  const [role, setRole] = useState<RoleBucket>('all');
  const [text, setText] = useState('');

  const all = q.data ?? [];
  const list = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return all.filter((p) => personInBucket(p.roles, role) && (!needle || p.name.toLowerCase().includes(needle)));
  }, [all, role, text]);

  return (
    <div className="page page--people">
      {!desktop && <LibraryTabs active="people" />}
      <header className="libhead">
        <div>
          <h1 className="pagehead__title">People</h1>
          <p className="pagehead__sub">
            {q.isLoading ? ' ' : list.length === all.length ? plural(all.length, 'person', 'people') : `${list.length} of ${plural(all.length, 'person', 'people')}`}
          </p>
        </div>
      </header>

      <div className="peoplehead">
        <label className="filterbox">
          <Search size={16} />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Find a person"
            aria-label="Find a person"
          />
          {text ? <button className="btn-icon filterbox__x" aria-label="Clear search" onClick={() => setText('')}><X size={14} /></button> : null}
        </label>
        <div className="chips" role="group" aria-label="Filter by role">
          {ROLE_BUCKETS.map((b) => (
            <button
              key={b.id}
              className={`chip chip--btn${role === b.id ? ' is-set' : ''}`}
              aria-pressed={role === b.id}
              onClick={() => setRole(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {q.isError ? (
        <Empty title="Could not load people" icon={<Users size={28} />}>Is the rune server running?</Empty>
      ) : q.isLoading ? (
        <div className="peoplegrid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="pcard"><div className="avatar shimmer" style={{ width: 52, height: 52 }} /><div className="pcard__txt"><div className="skel skel--line shimmer" style={{ width: '60%' }} /><div className="skel skel--line shimmer" style={{ width: '80%' }} /></div></div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <Empty title="No people match" icon={<Users size={28} />}>
          {text ? `Nothing for “${text}” in this role.` : 'No credits have been stored for this role yet.'}
        </Empty>
      ) : (
        <div className="peoplegrid">
          {list.map((p) => (
            <Link key={p.id} to={`/person/${encId(p.id)}`} className="pcard">
              <Avatar name={p.name} id={p.id} size={52} />
              <div className="pcard__txt">
                <span className="pcard__name">{p.name}</span>
                <span className="pcard__meta">{plural(p.albumCount, 'album')}</span>
                <span className="pcard__roles" title={p.roles.join(', ')}>{p.roles.join(' · ')}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
