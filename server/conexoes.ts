import { Request, Response, Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { pool } from './db.js';
import { cifrar } from './segredo.js';
import { dadosDaConexao, esquecerConexao, testar } from './alvo.js';

/** Conexões salvas do usuário logado (o conexoes.ini do app desktop). A senha nunca volta para o navegador. */

interface Entrada {
  nome: string;
  servidor: string;
  porta: number;
  usuario: string;
  /** undefined = não informada (mantém a salva) */
  senha?: string;
  salvar_senha: boolean;
  banco: string;
  ambiente: number;
}

class Invalido extends Error {}

function ler(body: unknown): Entrada {
  const b = (body || {}) as Record<string, unknown>;
  const texto = (v: unknown, max: number, rotulo: string) => {
    const t = String(v ?? '').trim();
    if (t.length > max) throw new Invalido(`${rotulo}: valor grande demais.`);
    return t;
  };
  const servidor = texto(b.servidor, 255, 'Servidor');
  if (!servidor) throw new Invalido('Informe o servidor.');
  const porta = Number(b.porta);
  if (!Number.isInteger(porta) || porta <= 0 || porta > 65535) throw new Invalido('Porta inválida.');
  const usuario = texto(b.usuario, 100, 'Usuário');
  if (!usuario) throw new Invalido('Informe o usuário.');
  const ambiente = Number(b.ambiente) || 0;
  if (![0, 1, 2, 3].includes(ambiente)) throw new Invalido('Ambiente inválido.');
  if (b.senha !== undefined && typeof b.senha !== 'string') throw new Invalido('Senha inválida.');
  return {
    nome: texto(b.nome, 100, 'Nome da conexão') || servidor.slice(0, 100), // em branco: usa o nome do servidor
    servidor,
    porta,
    usuario,
    senha: b.senha as string | undefined,
    salvar_senha: Boolean(b.salvar_senha),
    banco: texto(b.banco, 64, 'Banco'),
    ambiente,
  };
}

const COLUNAS = 'id, nome, servidor, porta, usuario, banco, ambiente, salvar_senha, (salvar_senha = 1 AND senha IS NOT NULL) AS tem_senha';

const publica = (l: RowDataPacket) => ({
  id: Number(l.id),
  nome: String(l.nome),
  servidor: String(l.servidor),
  porta: Number(l.porta),
  usuario: String(l.usuario),
  banco: String(l.banco),
  ambiente: Number(l.ambiente),
  salvar_senha: Boolean(l.salvar_senha),
  tem_senha: Boolean(l.tem_senha),
});

export function createConexoesRouter(): Router {
  const r = Router();

  const falha = (res: Response, e: unknown) => {
    const err = e as { message: string; code?: string; status?: number; codigo?: string };
    if (e instanceof Invalido) return res.status(400).json({ erro: err.message });
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ erro: 'Já existe uma conexão com esse nome.' });
    res.status(err.status || 500).json({ erro: err.message, codigo: err.codigo });
  };

  const uma = async (usuarioId: number, id: number) => {
    const [linhas] = await pool.query<RowDataPacket[]>(`SELECT ${COLUNAS} FROM conexoes WHERE id = ? AND usuario_id = ?`, [id, usuarioId]);
    return linhas.length ? publica(linhas[0]) : null;
  };

  r.get('/api/conexoes', async (_req: Request, res: Response) => {
    try {
      const [linhas] = await pool.query<RowDataPacket[]>(`SELECT ${COLUNAS} FROM conexoes WHERE usuario_id = ? ORDER BY id`, [res.locals.usuarioId]);
      res.json(linhas.map(publica));
    } catch (e) {
      falha(res, e);
    }
  });

  r.post('/api/conexoes', async (req: Request, res: Response) => {
    try {
      const c = ler(req.body);
      const senha = c.salvar_senha && c.senha !== undefined ? cifrar(c.senha) : null;
      const [ok] = await pool.query<ResultSetHeader>(
        'INSERT INTO conexoes (usuario_id, nome, servidor, porta, usuario, senha, salvar_senha, banco, ambiente) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [res.locals.usuarioId, c.nome, c.servidor, c.porta, c.usuario, senha, c.salvar_senha ? 1 : 0, c.banco, c.ambiente],
      );
      res.status(201).json(await uma(res.locals.usuarioId, ok.insertId));
    } catch (e) {
      falha(res, e);
    }
  });

  r.put('/api/conexoes/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const c = ler(req.body);
      // Salvar senha sem senha nova: mantém a que já estava; desligado: apaga a salva
      const senhaSql = !c.salvar_senha ? 'NULL' : c.senha !== undefined ? '?' : 'senha';
      const valores: unknown[] = [c.nome, c.servidor, c.porta, c.usuario];
      if (senhaSql === '?') valores.push(cifrar(c.senha!));
      valores.push(c.salvar_senha ? 1 : 0, c.banco, c.ambiente, id, res.locals.usuarioId);
      const [ok] = await pool.query<ResultSetHeader>(
        `UPDATE conexoes SET nome = ?, servidor = ?, porta = ?, usuario = ?, senha = ${senhaSql}, salvar_senha = ?, banco = ?, ambiente = ? WHERE id = ? AND usuario_id = ?`,
        valores,
      );
      if (!ok.affectedRows) return res.status(404).json({ erro: 'Conexão não encontrada.' });
      esquecerConexao(res.locals.usuarioId, id);
      res.json(await uma(res.locals.usuarioId, id));
    } catch (e) {
      falha(res, e);
    }
  });

  r.delete('/api/conexoes/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const [ok] = await pool.query<ResultSetHeader>('DELETE FROM conexoes WHERE id = ? AND usuario_id = ?', [id, res.locals.usuarioId]);
      if (!ok.affectedRows) return res.status(404).json({ erro: 'Conexão não encontrada.' });
      esquecerConexao(res.locals.usuarioId, id);
      res.json({ ok: true });
    } catch (e) {
      falha(res, e);
    }
  });

  /**
   * Testar conexão com os dados digitados na tela (ainda não salvos). Com id e sem senha, usa a senha salva.
   * bancos = true devolve também a lista de bancos (combo "Banco" do cadastro).
   */
  r.post('/api/conexoes/testar', async (req: Request, res: Response) => {
    try {
      const c = ler(req.body);
      let senha = c.senha;
      if (senha === undefined && req.body?.id) senha = (await dadosDaConexao(res.locals.usuarioId, Number(req.body.id), undefined)).password;
      if (senha === undefined) return res.status(400).json({ erro: 'Informe a senha.', codigo: 'SENHA' });
      res.json(await testar({ host: c.servidor, port: c.porta, user: c.usuario, password: senha }, Boolean(req.body?.bancos)));
    } catch (e) {
      falha(res, e);
    }
  });

  return r;
}
