import { AudioLines, Disc3, Home, ListMusic, Mic2, PanelLeftClose, PanelLeftOpen, Plus, Radio, Tags } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { usePlaylistUi } from '../store/playlistUi';
import { useUi } from '../store/ui';
import { Logo } from './Logo';

const item = ({ isActive }: { isActive: boolean }) => `side__item${isActive ? ' is-active' : ''}`;

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  return (
    <nav className={`side${collapsed ? ' side--collapsed' : ''}`} aria-label="Library">
      <div className="side__brand"><Logo size={26} /><span className="side__word">rune</span></div>
      <div className="side__group">
        <NavLink to="/" end className={item} title="Home"><Home size={18} /><span>Home</span></NavLink>
        <NavLink to="/albums" className={item} title="Albums" end={false}><Disc3 size={18} /><span>Albums</span></NavLink>
        <NavLink to="/artists" className={item} title="Artists"><Mic2 size={18} /><span>Artists</span></NavLink>
        <NavLink to="/tracks" className={item} title="Tracks"><AudioLines size={18} /><span>Tracks</span></NavLink>
        <NavLink to="/genres" className={item} title="Genres"><Tags size={18} /><span>Genres</span></NavLink>
        <NavLink to="/radio" className={item} title="Radio"><Radio size={18} /><span>Radio</span></NavLink>
      </div>
      <hr className="side__rule" />
      <div className="side__group">
        <NavLink to="/albums?source=spotify" className={({ isActive }) => `side__item${isActive && location.search.includes('spotify') ? ' is-active' : ''}`} title="Spotify">
          <i className="side__spot" /><span>Spotify</span>
        </NavLink>
        <NavLink to="/playlists" className={item} title="Playlists"><ListMusic size={18} /><span>Playlists</span></NavLink>
        <button className="side__item side__item--new" title="New playlist" onClick={() => usePlaylistUi.getState().openNew()}><Plus size={18} /><span>New playlist</span></button>
      </div>
      <button className="side__collapse btn-icon" onClick={toggle} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
      </button>
    </nav>
  );
}
