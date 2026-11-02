import type { Album } from '@liner/shared';
import { Link } from 'react-router-dom';
import { tileGradient } from '../../lib/color';
import { formatTrackRefs, groupCredits } from '../../lib/credits';
import { encId, initials } from '../../lib/format';

export function Avatar({ name, id, size = 44 }: { name: string; id: string; size?: number }) {
  return <span className="avatar" style={{ width: size, height: size, background: tileGradient(id), fontSize: size * 0.36 }} aria-hidden>{initials(name)}</span>;
}

export function Credits({ album }: { album: Album }) {
  const groups = groupCredits(album.credits);
  return (
    <div className="credits">
      {groups.map((g) => (
        <div key={g.name} className="credits__group">
          <h3 className="eyebrow credits__title">{g.name}</h3>
          <ul className="credits__grid">
            {g.people.map((p) => (
              <li key={p.artist.id} className="person">
                <Link to={`/person/${encId(p.artist.id)}`} className="person__avatar" tabIndex={-1}><Avatar name={p.artist.name} id={p.artist.id} /></Link>
                <div className="person__txt">
                  <Link to={`/person/${encId(p.artist.id)}`} className="person__name">{p.artist.name}</Link>
                  <span className="person__roles">
                    {p.roles.map((r, i) => (
                      <span key={r.role}>
                        {i > 0 && ', '}
                        {r.role}
                        {r.trackIds && <span className="person__tracks"> ({formatTrackRefs(r.trackIds, album.tracks)})</span>}
                      </span>
                    ))}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
