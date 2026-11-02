import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Ambient } from './components/Ambient';
import { Shell } from './components/Shell';
import AlbumPage from './pages/Album';
import Albums from './pages/Albums';
import ArtistPage from './pages/Artist';
import Artists from './pages/Artists';
import Discover from './pages/Discover';
import Genres, { GenrePage } from './pages/Genres';
import Home from './pages/Home';
import Placeholder from './pages/Placeholder';
import PlaylistPage from './pages/Playlist';
import Playlists from './pages/Playlists';
import SearchPage from './pages/Search';
import Tracks from './pages/Tracks';
import { ReviewPreviewHost } from './components/ReviewPreview';
import { startHistoryReporter } from './lib/historyReporter';
import { usePlayer } from './store/player';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export default function App() {
  useEffect(() => { void usePlayer.getState().init(); }, []);
  useEffect(() => startHistoryReporter(), []);
  return (
    <QueryClientProvider client={client}>
      <Ambient />
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/album/:id" element={<AlbumPage />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/tracks" element={<Tracks />} />
            <Route path="/genres" element={<Genres />} />
            <Route path="/genres/:genre" element={<GenrePage />} />
            <Route path="/discover" element={<Discover />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/playlist/:id" element={<PlaylistPage />} />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Routes>
        </Shell>
        <ReviewPreviewHost />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
