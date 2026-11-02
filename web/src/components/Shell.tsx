import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ScrollRootContext } from '../hooks/scrollRoot';
import { useIsDesktop } from '../hooks/useMedia';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { MediaSessionBridge } from './MediaSession';
import { PlayOnSheet } from './PlayOnSheet';
import { PlaylistDialogsHost } from './PlaylistDialogs';
import { MobileTabs } from './MobileTabs';
import { NowPlaying } from './player/NowPlaying';
import { MiniPlayer } from './player/MiniPlayer';
import { NowPlayingBar } from './player/NowPlayingBar';
import { QueueDrawer } from './player/Queue';
import { Sidebar } from './Sidebar';
import { Toast } from './Toast';
import { TopBar } from './TopBar';

const scrollPos = new Map<string, number>();

export function Shell({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const maxIdx = useRef(0);
  const idx = (window.history.state?.idx as number | undefined) ?? 0;
  maxIdx.current = Math.max(maxIdx.current, idx);
  const hasQueue = usePlayer((s) => s.state.queue.length > 0);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setQueue = useUi((s) => s.setQueueOpen);
  const setNp = useUi((s) => s.setNowPlayingOpen);

  useLayoutEffect(() => {
    const el = main.current;
    if (!el) return;
    const y = scrollPos.get(loc.key) ?? 0;
    el.scrollTop = y;
    // content may mount a frame late (virtualized lists)
    if (y) requestAnimationFrame(() => { el.scrollTop = y; });
  }, [loc.key]);

  useEffect(() => {
    setQueue(false);
    setNp(false);
  }, [loc.pathname, setQueue, setNp]);

  const canBack = idx > 0;

  return (
    <div className={`shell ${desktop ? 'shell--desktop' : 'shell--mobile'}${desktop && collapsed ? ' shell--collapsed' : ''}${!desktop && hasQueue ? ' shell--mini' : ''}`}>
      {desktop && <Sidebar />}
      <div className="shell__col">
        {desktop && <TopBar canBack={canBack} canForward={idx < maxIdx.current} />}
        <main
          className="main"
          ref={main}
          onScroll={(e) => scrollPos.set(loc.key, e.currentTarget.scrollTop)}
          id="main"
        >
          <ScrollRootContext.Provider value={main}>{children}</ScrollRootContext.Provider>
        </main>
      </div>
      {desktop ? <NowPlayingBar /> : (<><MiniPlayer /><MobileTabs /></>)}
      <QueueDrawer />
      <NowPlaying />
      <MediaSessionBridge />
      <PlayOnSheet />
      <PlaylistDialogsHost />
      <Toast />
    </div>
  );
}
