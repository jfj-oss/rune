import { Home, Library, ListMusic, Search } from 'lucide-react';
import { NavLink, useLocation } from 'react-router-dom';
import { useUi } from '../store/ui';

export function MobileTabs() {
  const queueOpen = useUi((s) => s.queueOpen);
  const setQueue = useUi((s) => s.setQueueOpen);
  const setNp = useUi((s) => s.setNowPlayingOpen);
  const { pathname } = useLocation();
  const close = () => { setQueue(false); setNp(false); };
  const libActive = !queueOpen && /^\/(albums|artists|album|artist|tracks|genres|playlists?|discover)/.test(pathname);
  const cls = (a: boolean) => `tab${a ? ' is-active' : ''}`;
  return (
    <nav className="tabs" aria-label="Main">
      <NavLink to="/" end onClick={close} className={({ isActive }) => cls(isActive && !queueOpen)}><Home size={22} /><span>Home</span></NavLink>
      <NavLink to="/albums" onClick={close} className={() => cls(libActive)}><Library size={22} /><span>Library</span></NavLink>
      <NavLink to="/search" onClick={close} className={({ isActive }) => cls(isActive && !queueOpen)}><Search size={22} /><span>Search</span></NavLink>
      <button className={cls(queueOpen)} onClick={() => { setNp(false); setQueue(!queueOpen); }}><ListMusic size={22} /><span>Queue</span></button>
    </nav>
  );
}
