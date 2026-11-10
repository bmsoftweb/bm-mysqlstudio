import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  // Versão do package.json na tela (rodapé do login e Ajuda > Sobre)
  define: {
    __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version),
  },
  server: {
    // Porta de HMR própria, para rodar junto com os outros projetos (crmWeb usa 24679)
    hmr: process.env.DISABLE_HMR === 'true' ? false : { port: 24685 },
  },
}));
