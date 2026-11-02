import { installClientLog } from './clientLog';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/browse.css';
import './styles/ambient.css';
import './styles/spotify.css';
import './styles/playlists.css';
import './styles/radio.css';
import './styles/newsongs.css';
import './styles/discover.css';

installClientLog();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
