import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { stillQuery } from '../lib/effects';
import { useLocation } from 'react-router-dom';
import { ScrollRootContext } from '../hooks/scrollRoot';
import { useIsDesktop } from '../hooks/useMedia';
import { listenApi } from '../listenApi';
import { isLiveTrack } from '../lib/listenTypes';
import { useDiscoverUi } from '../store/discoverUi';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { MediaSessionBridge } from './MediaSession';
import { KeyboardShortcuts } from './Shortcuts';
import { PlayOnSheet } from './PlayOnSheet';
import { PlaylistDialogsHost } from './PlaylistDialogs';
import { MobileTabs } from './MobileTabs';
import { SongRadio } from './SongRadio';
import { TrackContextMenu } from './TrackMenu';
import { NowPlaying } from './player/NowPlaying';
import { MiniPlayer } from './player/MiniPlayer';
import { NowPlayingBar } from './player/NowPlayingBar';
import { QueueDrawer } from './player/Queue';
import { Sidebar } from './Sidebar';
import { Toast } from './Toast';
import { TopBar } from './TopBar';
import { UpdateChip } from './UpdateChip';

const scrollPos = new Map<string, number>();

export function Shell({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const maxIdx = useRef(0);
  const idx = (window.history.state?.idx as number | undefined) ?? 0;
  maxIdx.current = Math.max(maxIdx.current, idx);
  const hasQueue = usePlayer((s) => s.state.queue.length > 0);
  const nextTrack = usePlayer((s) => s.state.queue[s.state.index + 1]?.track);
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

  // a gentle fade + 4 px rise when the route changes (skipped on first load and with reduced motion). Plain Web Animations
  // on the page element: nothing re-mounts, no layout change, and Now Playing / the drawers sit outside <main>.
  const firstRoute = useRef(true);
  useLayoutEffect(() => {
    if (firstRoute.current) { firstRoute.current = false; return; }
    if (stillQuery().matches) return;
    main.current?.firstElementChild?.animate?.(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
  }, [loc.pathname]);

  useEffect(() => {
    setQueue(false);
    setNp(false);
    useDiscoverUi.getState().closeTrackMenu();
    useDiscoverUi.getState().closeRadio();
  }, [loc.pathname, setQueue, setNp]);

  // Warm the next track's waveform so it is ready the moment it starts.
  const nextId = nextTrack?.id;
  const nextSource = nextTrack?.source;
  useEffect(() => {
    if (!nextId || nextSource === 'spotify' || isLiveTrack(nextTrack)) return;
    listenApi.prefetchPeaks(nextId, 400);
    listenApi.prefetchPeaks(nextId, 800);
  }, [nextId, nextSource, nextTrack]);

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
      {!desktop && <UpdateChip className="chip--float" />}
      <QueueDrawer />
      <NowPlaying />
      <MediaSessionBridge />
      <KeyboardShortcuts />
      <PlayOnSheet />
      <PlaylistDialogsHost />
      <TrackContextMenu />
      <SongRadio />
      <Toast />
    </div>
  );
}
