import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { instalarSelecaoAoFocar } from './lib/selecaoAoFocar';
import './index.css';

instalarSelecaoAoFocar();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
