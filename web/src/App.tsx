import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Ambient } from './components/Ambient';
import { PageSkeleton } from './components/PageSkeleton';
import { Shell } from './components/Shell';
import { ReviewPreviewHost } from './components/ReviewPreview';
import { startHistoryReporter } from './lib/historyReporter';
import { socket } from './player/remote';
import { usePlayer } from './store/player';
import { useRadio } from './store/radio';

/* Pages are route-split: the shell, sidebar, player bar, mini player and Now Playing stay in the
   main chunk; every page is fetched on first visit (iPhone over Tailscale has a slow link). */
const Home = lazy(() => import('./pages/Home'));
const Albums = lazy(() => import('./pages/Albums'));
const AlbumPage = lazy(() => import('./pages/Album'));
const Artists = lazy(() => import('./pages/Artists'));
const ArtistPage = lazy(() => import('./pages/Artist'));
const People = lazy(() => import('./pages/People'));
const PersonPage = lazy(() => import('./pages/Person'));
const Stats = lazy(() => import('./pages/Stats'));
const Duplicates = lazy(() => import('./pages/Duplicates'));
const Settings = lazy(() => import('./pages/Settings'));
const SearchPage = lazy(() => import('./pages/Search'));
const Tracks = lazy(() => import('./pages/Tracks'));
const Genres = lazy(() => import('./pages/Genres'));
const GenrePage = lazy(() => import('./pages/Genres').then((m) => ({ default: m.GenrePage })));
const RadioPage = lazy(() => import('./pages/Radio'));
const Discover = lazy(() => import('./pages/Discover'));
const Playlists = lazy(() => import('./pages/Playlists'));
const PlaylistPage = lazy(() => import('./pages/Playlist'));
const Placeholder = lazy(() => import('./pages/Placeholder'));

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export default function App() {
  useEffect(() => { void usePlayer.getState().init(); }, []);
  useEffect(() => { void useRadio.getState().loadAutoRadio(); }, []);
  useEffect(() => startHistoryReporter(), []);
  // Any client that changed the Spotify library (a heart, adding to Liked Songs
  // from a playlist, an album save) makes every open view refetch: the heart and
  // the Liked Songs page agree without a reload.
  useEffect(() => socket.on((e) => {
    if (e.type !== 'library-changed') return;
    void client.invalidateQueries({ queryKey: ['liked'] });
    void client.invalidateQueries({ queryKey: ['playlist'] });
    void client.invalidateQueries({ queryKey: ['playlists'] });
  }), []);
  return (
    <QueryClientProvider client={client}>
      <Ambient />
      <BrowserRouter>
        <Shell>
          <Suspense fallback={<PageSkeleton />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/albums" element={<Albums />} />
              <Route path="/album/:id" element={<AlbumPage />} />
              <Route path="/artists" element={<Artists />} />
              <Route path="/artist/:id" element={<ArtistPage />} />
              <Route path="/people" element={<People />} />
              <Route path="/person/:id" element={<PersonPage />} />
              <Route path="/stats" element={<Stats />} />
              <Route path="/duplicates" element={<Duplicates />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/tracks" element={<Tracks />} />
              <Route path="/genres" element={<Genres />} />
              <Route path="/genres/:genre" element={<GenrePage />} />
              <Route path="/radio" element={<RadioPage />} />
              <Route path="/discover" element={<Discover />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlist/:id" element={<PlaylistPage />} />
              <Route path="*" element={<Placeholder title="Not found" />} />
            </Routes>
          </Suspense>
        </Shell>
        <ReviewPreviewHost />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
