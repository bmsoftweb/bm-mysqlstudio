import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { instalarSelecaoAoFocar } from './lib/selecaoAoFocar';
import './index.css';

instalarSelecaoAoFocar();

// PWA instalável: o service worker só entra no build (no dev atrapalharia o Vite)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('Service worker:', e));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
