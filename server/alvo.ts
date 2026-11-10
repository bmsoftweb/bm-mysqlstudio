import crypto from 'crypto';
import mysql from 'mysql2';
import { Request, Response, Router } from 'express';
import { pool as poolApp } from './db.js';
import { decifrar } from './segredo.js';

/**
 * MySQL "alvo": os servidores que o usuário administra (as conexões salvas). O navegador manda o SQL e este
 * módulo executa; a lógica das telas (metadados, comparação, backup) fica no cliente, em pedaços pequenos,
 * porque na Vercel cada requisição tem limite de tempo e de tamanho.
 */

export interface DadosAlvo {
  host: string;
  port: number;
  user: string;
  password: string;
}

const OPCOES = {
  multipleStatements: true, // a aba SQL manda o texto inteiro, como o FireDAC (CREATE TRIGGER com ';' no corpo)
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  jsonStrings: true,
  rowsAsArray: true,
  charset: 'utf8mb4',
  connectTimeout: 15000,
} as const;

/** A Vercel recusa resposta acima de 4,5 MB: o resultado é cortado antes (truncado = true). */
const ORCAMENTO_BYTES = 3_200_000;
/** Valor sozinho acima disso vai como { bin: null, bytes }: o cliente busca em pedaços (lerGrande). */
const VALOR_MAXIMO = 1_000_000;
const LIMITE_PADRAO = 1000;
const LIMITE_MAXIMO = 200_000;

export type Valor = string | number | null | { bin: string | null; bytes?: number };

export interface Campo {
  nome: string;
  /** Nome da coluna na tabela (sem o apelido do SELECT); '' se for expressão */
  coluna: string;
  tabela: string;
  banco: string;
  tipo: number;
  tamanho: number;
  decimais: number;
  flags: number;
  charset: number;
}

export interface Conjunto {
  campos: Campo[];
  linhas: Valor[][];
  truncado: boolean;
}

export interface Feito {
  afetadas: number;
  idInserido: string;
  info: string;
}

export type Resultado = Conjunto | Feito;

// ==========================================================
// Pools por servidor e conexões presas às abas (sessões)
// ==========================================================
// ponytail: tudo em memória do processo. Local e com Fluid Compute da Vercel (uma instância atende várias
// requisições) funciona; se a requisição cair em outra instância, a sessão da aba nasce de novo e o cliente é
// avisado (sessaoNova). Sessão que não pode se perder (transação longa) pede servidor próprio.
interface Grupo {
  pool: mysql.Pool;
  usado: number;
}
interface Sessao {
  conn: mysql.PoolConnection;
  grupo: string;
  usado: number;
  ocupada: boolean;
}

const grupos = new Map<string, Grupo>();
const sessoes = new Map<string, Sessao>();

const SESSAO_OCIOSA_MS = 15 * 60_000;
const GRUPO_OCIOSO_MS = 10 * 60_000;

const faxina = setInterval(() => {
  const agora = Date.now();
  for (const [chave, s] of sessoes) {
    if (!s.ocupada && agora - s.usado > SESSAO_OCIOSA_MS) {
      sessoes.delete(chave);
      s.conn.destroy(); // destroy e não release: variáveis, tabelas temporárias e transação não voltam para o pool
    }
  }
  for (const [chave, g] of grupos) {
    const emUso = [...sessoes.values()].some((s) => s.grupo === chave);
    if (!emUso && agora - g.usado > GRUPO_OCIOSO_MS) {
      grupos.delete(chave);
      g.pool.end(() => {});
    }
  }
}, 60_000);
faxina.unref();

function chaveGrupo(usuarioId: number, d: DadosAlvo): string {
  const senha = crypto.createHash('sha256').update(d.password).digest('hex').slice(0, 16);
  return `${usuarioId}|${d.host}|${d.port}|${d.user}|${senha}`;
}

function grupoDe(chave: string, d: DadosAlvo): Grupo {
  let g = grupos.get(chave);
  if (!g) {
    g = {
      pool: mysql.createPool({ ...OPCOES, ...d, waitForConnections: true, connectionLimit: 6, maxIdle: 2, idleTimeout: 60_000, enableKeepAlive: true }),
      usado: 0,
    };
    grupos.set(chave, g);
  }
  g.usado = Date.now();
  return g;
}

const pegar = (p: mysql.Pool) =>
  new Promise<mysql.PoolConnection>((ok, falha) => p.getConnection((e, c) => (e ? falha(e) : ok(c))));

const simples = (conn: mysql.PoolConnection | mysql.Connection | mysql.Pool, sql: string) =>
  new Promise<unknown[][]>((ok, falha) => conn.query(sql, (e: Error | null, linhas: unknown) => (e ? falha(e) : ok(linhas as unknown[][]))));

const crase = (nome: string) => '`' + nome.replace(/`/g, '``') + '`';

// ==========================================================
// Execução
// ==========================================================
const TIPO_BIT = 16;

function converter(v: unknown, tipo: number): Valor {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    if (tipo === TIPO_BIT) return v.length ? BigInt('0x' + v.toString('hex')).toString() : '0';
    return v.length > VALOR_MAXIMO ? { bin: null, bytes: v.length } : { bin: v.toString('base64') };
  }
  if (typeof v === 'string') return v.length > VALOR_MAXIMO ? { bin: null, bytes: Buffer.byteLength(v) } : v;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return v.toString();
  return JSON.stringify(v); // GEOMETRY chega como objeto
}

function peso(v: Valor): number {
  if (v === null) return 4;
  if (typeof v === 'string') return Buffer.byteLength(v) + 3;
  if (typeof v === 'number') return 12;
  return (v.bin?.length ?? 0) + 24;
}

interface Saida {
  resultados: Resultado[];
  erro?: { message: string; errno?: number; sqlMessage?: string };
  cortado: boolean;
}

/**
 * Roda um texto SQL (uma ou várias instruções) lendo as linhas uma a uma: passando do limite de linhas ou do
 * orçamento de bytes, a consulta é interrompida com KILL QUERY e o que veio até ali é devolvido como truncado.
 */
function rodar(conn: mysql.PoolConnection, sql: string, params: unknown[] | undefined, limite: number, orcamento: { bytes: number }, matar: () => void): Promise<Saida> {
  return new Promise((resolver) => {
    const saida: Saida = { resultados: [], cortado: false };
    let atual: Conjunto | null = null;
    const consulta = conn.query({ sql, values: params, rowsAsArray: true } as mysql.QueryOptions);
    consulta
      .on('fields', (fields: mysql.FieldPacket[] | undefined) => {
        if (!fields) return; // instrução sem resultado: vem o cabeçalho em 'result'
        atual = {
          campos: fields.map((f) => ({
            nome: f.name,
            coluna: f.orgName || '',
            tabela: f.orgTable || '',
            banco: (f as unknown as { schema?: string }).schema || f.db || '',
            tipo: Number(f.columnType ?? f.type ?? 0),
            tamanho: Number(f.columnLength ?? f.length ?? 0),
            decimais: Number(f.decimals ?? 0),
            flags: Number(Array.isArray(f.flags) ? 0 : f.flags ?? 0),
            charset: Number((f as unknown as { characterSet?: number }).characterSet ?? 0),
          })),
          linhas: [],
          truncado: false,
        };
        saida.resultados.push(atual);
      })
      .on('result', (linha: unknown) => {
        if (Array.isArray(linha)) {
          if (!atual || atual.truncado) return;
          if (atual.linhas.length >= limite || orcamento.bytes > ORCAMENTO_BYTES) {
            atual.truncado = true;
            saida.cortado = true;
            matar();
            return;
          }
          const campos = atual.campos;
          const l = linha.map((v, i) => converter(v, campos[i].tipo));
          for (const v of l) orcamento.bytes += peso(v);
          atual.linhas.push(l);
        } else {
          const h = linha as mysql.ResultSetHeader;
          atual = null;
          saida.resultados.push({ afetadas: h.affectedRows ?? 0, idInserido: String(h.insertId ?? 0), info: h.info || '' });
        }
      })
      .on('error', (e: Saida['erro']) => {
        saida.erro = e;
      })
      .on('end', () => resolver(saida));
  });
}

function textoErro(e: { message: string; errno?: number; sqlMessage?: string }): string {
  return e.errno ? `Erro ${e.errno}: ${e.sqlMessage || e.message}` : e.message;
}

/** Senha errada ou usuário sem acesso: o cliente pede a senha de novo. */
const ERROS_DE_ACESSO = new Set([1045, 1044, 1698]);

class ErroAlvo extends Error {
  constructor(
    mensagem: string,
    public status = 400,
    public codigo = '',
  ) {
    super(mensagem);
  }
}

function erroDeConexao(e: { message: string; errno?: number; code?: string; sqlMessage?: string }): ErroAlvo {
  if (e instanceof ErroAlvo) return e;
  if (e.errno && ERROS_DE_ACESSO.has(e.errno)) return new ErroAlvo(textoErro(e), 400, 'SENHA');
  return new ErroAlvo(`Falha na conexão: ${e.errno ? textoErro(e) : e.code ? `${e.code} ${e.message}` : e.message}`, 502, 'CONEXAO');
}

// ==========================================================
// Conexão salva -> dados de acesso
// ==========================================================
interface LinhaConexao {
  servidor: string;
  porta: number;
  usuario: string;
  senha: string | null;
  salvar_senha: number;
}

// 30 s de cache: as telas fazem dezenas de consultas pequenas por operação
const cacheConexoes = new Map<string, { linha: LinhaConexao; ate: number }>();
export const esquecerConexao = (usuarioId: number, id: number) => cacheConexoes.delete(`${usuarioId}|${id}`);

export async function dadosDaConexao(usuarioId: number, id: number, senhaInformada: unknown): Promise<DadosAlvo> {
  const chave = `${usuarioId}|${id}`;
  let c = cacheConexoes.get(chave);
  if (!c || c.ate < Date.now()) {
    const [linhas] = await poolApp.query<mysql.RowDataPacket[]>(
      'SELECT servidor, porta, usuario, senha, salvar_senha FROM conexoes WHERE id = ? AND usuario_id = ?',
      [id, usuarioId],
    );
    if (!linhas.length) throw new ErroAlvo('Conexão não encontrada.', 404);
    c = { linha: linhas[0] as LinhaConexao, ate: Date.now() + 30_000 };
    cacheConexoes.set(chave, c);
  }
  const l = c.linha;
  let senha: string | null = typeof senhaInformada === 'string' ? senhaInformada : null;
  if (senha === null && l.salvar_senha && l.senha) senha = decifrar(l.senha);
  if (senha === null) throw new ErroAlvo('Informe a senha da conexão.', 400, 'SENHA');
  return { host: l.servidor, port: Number(l.porta) || 3306, user: l.usuario, password: senha };
}

/** Testar conexão (tela de cadastro): versão do servidor e, se pedido, os bancos do usuário. */
export async function testar(d: DadosAlvo, comBancos: boolean): Promise<{ versao: string; bancos?: string[] }> {
  const conn = mysql.createConnection({ ...OPCOES, ...d });
  try {
    await new Promise<void>((ok, falha) => conn.connect((e) => (e ? falha(erroDeConexao(e)) : ok())));
    const [[versao]] = [await simples(conn, 'SELECT VERSION()')];
    const bancos = comBancos
      ? (
          await simples(
            conn,
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY 1",
          )
        ).map((l) => String(l[0]))
      : undefined;
    return { versao: String(versao[0]), bancos };
  } finally {
    conn.destroy();
  }
}

// ==========================================================
// Rotas
// ==========================================================
export function createAlvoRouter(): Router {
  const r = Router();

  /**
   * POST /api/sql { conexao, senha?, banco?, sessao?, exigeSessao?, sql: string | string[], params?, limite? }
   * -> { resultados, erro?, feitos, cortado, banco?, sessaoNova, ms }
   * Erro de SQL volta com status 200 (os resultados anteriores ao erro vêm junto); status de erro só para o que
   * impede a execução (conexão, senha, sessão ocupada).
   */
  r.post('/api/sql', async (req: Request, res: Response) => {
    const inicio = Date.now();
    const usuarioId: number = res.locals.usuarioId;
    const b = req.body || {};
    const textos: string[] = Array.isArray(b.sql) ? b.sql : [b.sql];
    if (!textos.length || textos.some((t) => typeof t !== 'string' || !t.trim())) return res.status(400).json({ erro: 'SQL não informado.' });
    const params = Array.isArray(b.params) ? b.params : undefined;
    const limite = Math.min(Math.max(Number(b.limite) || LIMITE_PADRAO, 1), LIMITE_MAXIMO);
    const banco = typeof b.banco === 'string' ? b.banco : '';
    const chaveSessao = typeof b.sessao === 'string' && b.sessao ? `${usuarioId}|${b.sessao}` : '';
    // Só consultas (metadados, dados): a conexão volta para o pool como veio
    const soLeitura = textos.every((t) => /^\s*(select|show|desc|describe|explain)\b/i.test(t) && !/;\s*\S/.test(t));

    let sessao: Sessao | undefined;
    let conn: mysql.PoolConnection | undefined;
    let g: Grupo;
    let sessaoNova = false;
    try {
      const dados = await dadosDaConexao(usuarioId, Number(b.conexao), b.senha);
      const cg = chaveGrupo(usuarioId, dados);
      g = grupoDe(cg, dados);
      if (chaveSessao) {
        sessao = sessoes.get(chaveSessao);
        if (sessao && sessao.grupo !== cg) {
          // a aba trocou de conexão: a sessão antiga não serve
          sessoes.delete(chaveSessao);
          sessao.conn.destroy();
          sessao = undefined;
        }
        if (sessao?.ocupada) return res.status(409).json({ erro: 'Esta aba já está executando um comando.' });
        if (!sessao) {
          if (b.exigeSessao) return res.status(409).json({ erro: 'A conexão do script foi perdida no meio da execução.', codigo: 'SESSAO_PERDIDA' });
          sessao = { conn: await pegar(g.pool), grupo: cg, usado: Date.now(), ocupada: false };
          sessoes.set(chaveSessao, sessao);
          sessaoNova = true;
          if (banco) await simples(sessao.conn, `USE ${crase(banco)}`);
        }
        sessao.ocupada = true;
        conn = sessao.conn;
      } else {
        conn = await pegar(g.pool);
        const c = conn as mysql.PoolConnection & { _banco?: string };
        if (banco && c._banco !== banco) {
          await simples(conn, `USE ${crase(banco)}`);
          c._banco = banco;
        }
      }
    } catch (e) {
      if (sessao && sessaoNova) {
        sessoes.delete(chaveSessao);
        sessao.conn.destroy();
      } else if (sessao) sessao.ocupada = false;
      else conn?.destroy();
      const erro = erroDeConexao(e as Error);
      return res.status(erro.status).json({ erro: erro.message, codigo: erro.codigo });
    }

    // KILL QUERY por outra conexão do pool: no limite de linhas e quando o navegador desiste (botão Parar)
    const threadId = conn.threadId;
    let morta = false; // a instrução em execução já recebeu o KILL
    let matou = false; // alguma instrução desta requisição recebeu
    let interrompidaPeloCliente = false;
    const matar = () => {
      if (morta || !threadId) return;
      morta = true;
      matou = true;
      g.pool.query(`KILL QUERY ${threadId}`, () => {});
    };
    res.on('close', () => {
      if (!res.writableFinished) {
        interrompidaPeloCliente = true;
        matar();
      }
    });

    const resultados: Resultado[] = [];
    const orcamento = { bytes: 0 };
    let erro: string | undefined;
    let feitos = 0;
    let cortado = false;
    try {
      for (const texto of textos) {
        morta = false;
        const s = await rodar(conn, texto, textos.length === 1 ? params : undefined, limite, orcamento, matar);
        resultados.push(...s.resultados);
        cortado = cortado || s.cortado;
        // 1317 = interrompida: pelo limite não é erro (o resultado sai marcado como truncado)
        if (s.erro && !(s.cortado && s.erro.errno === 1317)) {
          erro = interrompidaPeloCliente ? 'Consulta interrompida.' : textoErro(s.erro);
          break;
        }
        feitos++;
        if (s.cortado) break; // instruções depois da consulta cortada não rodam
      }
      let bancoAtual: string | undefined;
      if (sessao && textos.some((t) => /\buse\b/i.test(t))) {
        try {
          bancoAtual = String((await simples(conn, 'SELECT DATABASE()'))[0]?.[0] ?? '');
        } catch {
          // sem conseguir conferir (conexão caiu), o banco da aba fica como estava
        }
      }
      if (!res.writableEnded && !interrompidaPeloCliente) {
        res.json({ resultados, erro, feitos, cortado, banco: bancoAtual, sessaoNova, ms: Date.now() - inicio });
      }
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ erro: (e as Error).message });
    } finally {
      if (sessao) {
        sessao.ocupada = false;
        sessao.usado = Date.now();
      } else if (matou || erro) {
        // KILL atrasado pegaria a próxima consulta de quem reusasse a conexão; com erro pode ter ficado transação aberta
        conn.destroy();
      } else if (!soLeitura) {
        // Script na conexão do pool: SET, USE, transação e tabela temporária não podem vazar para a próxima consulta
        const c = conn as mysql.PoolConnection & { _banco?: string };
        c.changeUser({}, (e) => {
          if (e) return c.destroy();
          c._banco = undefined;
          c.release();
        });
      } else conn.release();
    }
  });

  /** Aba fechada: solta a conexão dela. */
  r.delete('/api/sessoes/:chave', (req: Request, res: Response) => {
    const chave = `${res.locals.usuarioId}|${req.params.chave}`;
    const s = sessoes.get(chave);
    if (s && !s.ocupada) {
      sessoes.delete(chave);
      s.conn.destroy();
    }
    res.json({ ok: true });
  });

  return r;
}
