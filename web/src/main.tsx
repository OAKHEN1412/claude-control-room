import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './styles.css';
import './scrollbar.css';
import { App } from './App';
import { ClipPage } from './components/ClipPage';
import './components/clip.css';
import { GalleryPage } from './components/GalleryPage';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const path = window.location.pathname.replace(/\/+$/, '');
createRoot(root).render(
  <StrictMode>
    {path === '/clip' ? <ClipPage /> : path === '/gallery' ? <GalleryPage /> : <App />}
  </StrictMode>,
);
