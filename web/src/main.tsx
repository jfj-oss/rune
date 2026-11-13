import { installClientLog } from './clientLog';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installCoverGlow } from './lib/coverGlow';
// Fonts ship with rune (no Google request); latin subsets load on demand via unicode-range.
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/browse.css';
import './styles/ambient.css';
import './styles/effects.css';
import './styles/spotify.css';
import './styles/playlists.css';
import './styles/radio.css';
import './styles/newsongs.css';
import './styles/discover.css';

installClientLog();
installCoverGlow();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
