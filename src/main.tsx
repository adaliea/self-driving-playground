import React, { Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import App from './App';
import { normalizeRoomCode } from './multiplayer/protocol';
import './index.css';

const HostView = lazy(() => import('./multiplayer/HostView').then((module) => ({ default: module.HostView })));
const PlayerView = lazy(() => import('./multiplayer/PlayerView').then((module) => ({ default: module.PlayerView })));
const Presentation = lazy(() => import('./presentation/Presentation').then((module) => ({ default: module.Presentation })));

function Root() {
  const path = window.location.pathname.replace(/\/+$/, '');
  if (path === '/host') return <HostView />;
  if (path === '/presentation') return <Presentation />;
  if (path === '/playground') return <App />;
  // Everything else is the race: the site root is where participants join.
  const play = /^\/play\/([^/]+)$/.exec(path);
  return <PlayerView initialRoomCode={play ? normalizeRoomCode(play[1]) : undefined} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
