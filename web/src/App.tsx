import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Ambient } from './components/Ambient';
import { Shell } from './components/Shell';
import AlbumPage from './pages/Album';
import Albums from './pages/Albums';
import ArtistPage from './pages/Artist';
import Artists from './pages/Artists';
import Duplicates from './pages/Duplicates';
import Genres, { GenrePage } from './pages/Genres';
import Home from './pages/Home';
import People from './pages/People';
import PersonPage from './pages/Person';
import Placeholder from './pages/Placeholder';
import PlaylistPage from './pages/Playlist';
import Playlists from './pages/Playlists';
import RadioPage from './pages/Radio';
import SearchPage from './pages/Search';
import Settings from './pages/Settings';
import Stats from './pages/Stats';
import Tracks from './pages/Tracks';
import { ReviewPreviewHost } from './components/ReviewPreview';
import { startHistoryReporter } from './lib/historyReporter';
import { usePlayer } from './store/player';
import { useRadio } from './store/radio';

const client = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
});

export default function App() {
  useEffect(() => { void usePlayer.getState().init(); }, []);
  useEffect(() => { void useRadio.getState().loadAutoRadio(); }, []);
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
