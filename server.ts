import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createApp } from './server/app.js';

/** Entrada para execução local (npm run dev / start). Na Vercel quem serve as rotas é api/index.ts */
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const app = createApp();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MySQL Studio rodando em http://localhost:${PORT}`);
    console.log(`MySQL do app: ${process.env.MYSQL_HOST} / ${process.env.MYSQL_DATABASE || 'mysqlstudio'}`);
  });
}

startServer().catch((err) => {
  console.error('Falha crítica ao iniciar o servidor:', err);
  process.exit(1);
});
