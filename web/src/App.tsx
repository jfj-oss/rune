import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import AlbumPage from './pages/Album';
import Albums from './pages/Albums';
import ArtistPage from './pages/Artist';
import Artists from './pages/Artists';
import Home from './pages/Home';
import Placeholder from './pages/Placeholder';
import SearchPage from './pages/Search';
import { usePlayer } from './store/player';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export default function App() {
  useEffect(() => { void usePlayer.getState().init(); }, []);
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/album/:id" element={<AlbumPage />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/tracks" element={<Placeholder title="Tracks" />} />
            <Route path="/genres" element={<Placeholder title="Genres" />} />
            <Route path="/playlists" element={<Placeholder title="Playlists" />} />
            <Route path="*" element={<Placeholder title="Not found" />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
