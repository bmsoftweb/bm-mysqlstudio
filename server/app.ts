import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { RowDataPacket } from 'mysql2';
import { pool } from './db.js';
import { SEGREDO } from './segredo.js';
import { createConexoesRouter } from './conexoes.js';
import { createAlvoRouter } from './alvo.js';

// ==========================================================
// Sessão: token "usuarioId.expiracao.assinatura" (HMAC-SHA256), como no crmWeb
// ==========================================================
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

const assinar = (dados: string) => crypto.createHmac('sha256', SEGREDO).update(dados).digest('base64url');

function emitirToken(usuarioId: number): string {
  const dados = `${usuarioId}.${Date.now() + VALIDADE_MS}`;
  return `${dados}.${assinar(dados)}`;
}

/** Id do usuário do token, ou null se inválido/expirado */
function lerToken(token: string): number | null {
  const [id, exp, assinatura] = String(token || '').split('.');
  if (!id || !exp || !assinatura) return null;
  const esperada = assinar(`${id}.${exp}`);
  if (esperada.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura))) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(id);
}

interface Usuario extends RowDataPacket {
  id: number;
  nome: string;
  email: string;
  senha_hash: string;
}

const usuarioPublico = (u: Usuario) => ({ id: Number(u.id), nome: u.nome, email: u.email });

const SQL_USUARIO = 'SELECT id, nome, email, senha_hash FROM usuarios WHERE ativo = 1';

/** Senha mínima: este app dá acesso aos bancos de produção cadastrados nas conexões */
const SENHA_MINIMA = 8;

// Tentativas de login erradas por e-mail: 8 em 15 minutos e o login espera.
// ponytail: contador na memória do processo (cada instância da Vercel tem o seu); passar para tabela se precisar valer entre instâncias.
const falhas = new Map<string, { n: number; ate: number }>();
const JANELA_MS = 15 * 60_000;
const MAX_FALHAS = 8;

// Usuário do token relido do banco no máximo a cada 30 s: as telas fazem dezenas de requisições por operação
const cacheUsuarios = new Map<number, { u: Usuario; ate: number }>();

/** App Express com todas as rotas /api. Local: server.ts adiciona o Vite e o listen; Vercel: api/index.ts */
export function createApp() {
  const app = express();
  // Lotes de script (restauração de backup) chegam perto do limite de 4,5 MB da Vercel
  app.use(express.json({ limit: '4mb' }));

  app.post('/api/login', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const senha = typeof req.body?.senha === 'string' ? req.body.senha : '';
      if (!email) return res.status(400).json({ erro: 'Informe o seu e-mail.' });

      const f = falhas.get(email);
      if (f && f.ate > Date.now() && f.n >= MAX_FALHAS) {
        return res.status(429).json({ erro: 'Muitas tentativas com senha errada. Aguarde 15 minutos e tente de novo.' });
      }
      const errou = (mensagem: string) => {
        const atual = f && f.ate > Date.now() ? f.n : 0;
        falhas.set(email, { n: atual + 1, ate: Date.now() + JANELA_MS });
        return res.status(401).json({ erro: mensagem });
      };

      const [rows] = await pool.query<Usuario[]>(`${SQL_USUARIO} AND LOWER(TRIM(email)) = ? LIMIT 1`, [email]);
      // Mesma mensagem para e-mail inexistente e senha errada: não revela quem tem cadastro
      if (!rows.length) return errou('E-mail ou senha incorretos.');
      const u = rows[0];

      // Senha em branco no banco = primeiro acesso: grava o que foi digitado em bcrypt
      let primeiroAcesso = false;
      if (!u.senha_hash || !u.senha_hash.trim()) {
        if (senha.length < SENHA_MINIMA) {
          return res.status(401).json({ erro: `Primeiro acesso: defina uma senha com pelo menos ${SENHA_MINIMA} caracteres.` });
        }
        await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [bcrypt.hashSync(senha, 10), u.id]);
        primeiroAcesso = true;
      } else if (!bcrypt.compareSync(senha, u.senha_hash)) {
        return errou('E-mail ou senha incorretos.');
      }
      falhas.delete(email);
      res.json({ token: emitirToken(Number(u.id)), usuario: usuarioPublico(u), primeiroAcesso });
    } catch (err) {
      res.status(500).json({ erro: (err as Error).message });
    }
  });

  // ==========================================================
  // Daqui para baixo, toda rota /api exige um token válido
  // ==========================================================
  app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    const usuarioId = lerToken(token);
    if (!usuarioId) return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    try {
      let c = cacheUsuarios.get(usuarioId);
      if (!c || c.ate < Date.now()) {
        const [rows] = await pool.query<Usuario[]>(`${SQL_USUARIO} AND id = ? LIMIT 1`, [usuarioId]);
        if (!rows.length) {
          cacheUsuarios.delete(usuarioId);
          return res.status(401).json({ erro: 'Seu usuário foi desativado. Fale com o administrador.' });
        }
        c = { u: rows[0], ate: Date.now() + 30_000 };
        cacheUsuarios.set(usuarioId, c);
      }
      res.locals.usuarioId = usuarioId;
      res.locals.usuario = c.u;
      next();
    } catch (err) {
      // Falha do banco do app não derruba a sessão do navegador
      res.status(503).json({ erro: (err as Error).message });
    }
  });

  /** Revalidação da sessão guardada no navegador (a checagem em si é o middleware acima) */
  app.get('/api/sessao', (_req: Request, res: Response) => {
    res.json({ usuario: usuarioPublico(res.locals.usuario) });
  });

  /** Troca da própria senha: confere a atual antes */
  app.post('/api/minha-senha', async (req: Request, res: Response) => {
    try {
      const u: Usuario = res.locals.usuario;
      const { atual, nova } = req.body || {};
      if (!bcrypt.compareSync(String(atual ?? ''), u.senha_hash)) return res.status(400).json({ erro: 'A senha atual não confere.' });
      if (typeof nova !== 'string' || nova.length < SENHA_MINIMA) {
        return res.status(400).json({ erro: `A nova senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.` });
      }
      await pool.query('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [bcrypt.hashSync(nova, 10), u.id]);
      cacheUsuarios.delete(Number(u.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ erro: (err as Error).message });
    }
  });

  app.use(createConexoesRouter());
  app.use(createAlvoRouter());

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ erro: 'Rota não encontrada.' });
  });

  return app;
}
