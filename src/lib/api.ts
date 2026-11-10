/**
 * Acesso ao servidor: login, conexões salvas e execução de SQL no MySQL alvo.
 *
 * O servidor só executa o SQL; a lógica das telas roda aqui no navegador (como as units do app desktop faziam
 * com Rows/RunScript). Cada chamada é uma requisição curta: a Vercel limita o tempo e o tamanho (4,5 MB) de
 * cada uma, então consulta grande volta cortada (truncado) e quem precisa de tudo busca em pedaços.
 */

/** Valor de célula. Binário (BLOB, BINARY) vem em base64; bin = null: grande demais para vir junto (ver lerGrande em db.ts). */
export type Valor = string | number | null | { bin: string | null; bytes?: number };

export interface Campo {
  /** Nome no resultado (o apelido do SELECT, se houver) */
  nome: string;
  /** Nome da coluna na tabela; '' se for expressão */
  coluna: string;
  /** Tabela de origem; '' se for expressão */
  tabela: string;
  banco: string;
  /** Tipo do protocolo MySQL (ver TIPO em db.ts) */
  tipo: number;
  tamanho: number;
  decimais: number;
  flags: number;
  /** 63 = binário */
  charset: number;
}

export interface Conjunto {
  campos: Campo[];
  linhas: Valor[][];
  /** Passou do limite de linhas ou do tamanho da resposta: há mais linhas no banco */
  truncado: boolean;
}

export interface Feito {
  afetadas: number;
  idInserido: string;
  info: string;
}

export type Resultado = Conjunto | Feito;
export const ehConjunto = (r: Resultado): r is Conjunto => 'campos' in r;

export interface RespostaSql {
  resultados: Resultado[];
  /** Erro do MySQL; os resultados anteriores ao erro vêm junto */
  erro?: string;
  /** Instruções concluídas (quando sql é uma lista) */
  feitos: number;
  cortado: boolean;
  /** Banco em uso depois de um USE (só com sessão) */
  banco?: string;
  /** A sessão da aba foi criada agora: variáveis, transação e tabelas temporárias anteriores não existem mais */
  sessaoNova: boolean;
  ms: number;
}

export interface Conexao {
  id: number;
  nome: string;
  servidor: string;
  porta: number;
  usuario: string;
  banco: string;
  /** 0 = nenhum, 1 = desenvolvimento, 2 = homologação, 3 = produção */
  ambiente: number;
  salvar_senha: boolean;
  tem_senha: boolean;
}

export interface DadosConexao {
  id?: number;
  nome: string;
  servidor: string;
  porta: number;
  usuario: string;
  /** undefined = não mexe na senha salva */
  senha?: string;
  salvar_senha: boolean;
  banco: string;
  ambiente: number;
}

/**
 * Onde um SQL roda: a conexão salva, o banco padrão e, nas abas que precisam manter a conexão entre execuções
 * (USE, variáveis, transação), a chave da sessão. É o "Params" do app desktop.
 */
export interface Alvo {
  conexao: number;
  banco?: string;
  sessao?: string;
}

export class ErroApi extends Error {
  constructor(
    mensagem: string,
    public status = 0,
    public codigo = '',
  ) {
    super(mensagem);
  }
}

export interface UsuarioSessao {
  id: number;
  nome: string;
  email: string;
}

// ==========================================================
// Sessão do app e senhas das conexões
// ==========================================================
let token = '';
let aoExpirar: (mensagem: string) => void = () => {};
/** Senhas digitadas para conexões sem "Salvar senha": só na memória, até fechar a página */
const senhas = new Map<number, string>();
let pedirSenha: (conexao: number, mensagem: string) => Promise<boolean> = async () => false;
const pedidos = new Map<number, Promise<boolean>>();

export const definirToken = (t: string) => {
  token = t;
};
export const aoExpirarSessao = (fn: (mensagem: string) => void) => {
  aoExpirar = fn;
};
/**
 * Quem mostra a tela da conexão quando o servidor responde que falta (ou está errada) a senha. Devolve true se o
 * usuário confirmou (a tela já guardou a senha com lembrarSenha ou gravou a conexão) e false se cancelou.
 */
export const aoPedirSenha = (fn: (conexao: number, mensagem: string) => Promise<boolean>) => {
  pedirSenha = fn;
};
export const lembrarSenha = (conexao: number, senha: string) => senhas.set(conexao, senha);
export const esquecerSenha = (conexao: number) => senhas.delete(conexao);
export const esquecerSenhas = () => senhas.clear();

async function chamar<T>(metodo: string, rota: string, corpo?: unknown, sinal?: AbortSignal): Promise<T> {
  let resposta: globalThis.Response;
  try {
    resposta = await fetch(rota, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: sinal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new ErroApi('Consulta interrompida.', 0, 'INTERROMPIDA');
    throw new ErroApi('Sem resposta do servidor. Confira a sua conexão com a internet.');
  }
  let dados: unknown = null;
  try {
    dados = await resposta.json();
  } catch {
    // resposta sem JSON (ex.: erro da própria Vercel)
  }
  if (!resposta.ok) {
    const d = (dados || {}) as { erro?: string; codigo?: string };
    const mensagem = d.erro || (resposta.status === 413 ? 'O comando é grande demais para uma requisição.' : `Erro ${resposta.status} no servidor.`);
    if (resposta.status === 401 && rota !== '/api/login') aoExpirar(mensagem);
    throw new ErroApi(mensagem, resposta.status, d.codigo || '');
  }
  return dados as T;
}

export const login = (email: string, senha: string) =>
  chamar<{ token: string; usuario: UsuarioSessao; primeiroAcesso: boolean }>('POST', '/api/login', { email, senha });
export const validarSessao = () => chamar<{ usuario: UsuarioSessao }>('GET', '/api/sessao');
export const trocarSenha = (atual: string, nova: string) => chamar<{ ok: true }>('POST', '/api/minha-senha', { atual, nova });

export const listarConexoes = () => chamar<Conexao[]>('GET', '/api/conexoes');
export const salvarConexao = (c: DadosConexao) =>
  c.id ? chamar<Conexao>('PUT', `/api/conexoes/${c.id}`, c) : chamar<Conexao>('POST', '/api/conexoes', c);
export const excluirConexao = (id: number) => chamar<{ ok: true }>('DELETE', `/api/conexoes/${id}`);
export const testarConexao = (c: DadosConexao, bancos = false) =>
  chamar<{ versao: string; bancos?: string[] }>('POST', '/api/conexoes/testar', { ...c, bancos });
export const fecharSessao = (sessao: string) => chamar('DELETE', `/api/sessoes/${encodeURIComponent(sessao)}`).catch(() => {});

// ==========================================================
// SQL no MySQL alvo
// ==========================================================
export interface OpcoesSql {
  params?: unknown[];
  /** Máximo de linhas por resultado (padrão do servidor: 1000) */
  limite?: number;
  sinal?: AbortSignal;
  /** Lote do meio de um script: recusa (ErroApi codigo SESSAO_PERDIDA) em vez de rodar numa sessão nova */
  exigeSessao?: boolean;
}

/**
 * Executa e devolve tudo o que veio, inclusive o erro do MySQL (em resposta.erro, sem exceção).
 * sql como lista: instruções executadas em ordem na mesma conexão, parando no primeiro erro.
 * Exceção (ErroApi) só para o que impede a execução: conexão, senha cancelada, sessão ocupada.
 */
export async function executar(alvo: Alvo, sql: string | string[], opcoes: OpcoesSql = {}): Promise<RespostaSql> {
  for (;;) {
    try {
      return await chamar<RespostaSql>(
        'POST',
        '/api/sql',
        {
          conexao: alvo.conexao,
          banco: alvo.banco || undefined,
          sessao: alvo.sessao,
          senha: senhas.get(alvo.conexao),
          sql,
          params: opcoes.params,
          limite: opcoes.limite,
          exigeSessao: opcoes.exigeSessao,
        },
        opcoes.sinal,
      );
    } catch (e) {
      if (!(e instanceof ErroApi) || e.codigo !== 'SENHA') throw e;
      // Falta a senha (ou a que estava na memória não vale mais): pede uma vez só, mesmo com várias consultas esperando
      senhas.delete(alvo.conexao);
      let pedido = pedidos.get(alvo.conexao);
      if (!pedido) {
        pedido = pedirSenha(alvo.conexao, e.message).finally(() => pedidos.delete(alvo.conexao));
        pedidos.set(alvo.conexao, pedido);
      }
      if (!(await pedido)) throw new ErroApi('Conexão cancelada: a senha não foi informada.', 400, 'CANCELADA');
    }
  }
}

/** Valor como texto: '' para nulo e para binário (use so em metadados e textos). */
export function texto(v: Valor): string {
  if (v === null) return '';
  if (typeof v === 'object') return '';
  return String(v);
}

/** Primeiro resultado com linhas de uma consulta; exceção com a mensagem do MySQL se der erro. */
export async function consulta(alvo: Alvo, sql: string, params?: unknown[], limite = 100_000): Promise<Conjunto> {
  const r = await executar(alvo, sql, { params, limite });
  if (r.erro) throw new Error(r.erro);
  return r.resultados.find(ehConjunto) ?? { campos: [], linhas: [], truncado: false };
}

/**
 * O Rows() do app desktop: todas as linhas como texto ('' para nulo). Para metadados e listas pequenas:
 * exceção se o resultado vier cortado.
 */
export async function linhas(alvo: Alvo, sql: string, params?: unknown[]): Promise<string[][]> {
  const c = await consulta(alvo, sql, params);
  if (c.truncado) throw new Error('O resultado é grande demais para ser lido de uma vez.');
  return c.linhas.map((l) => l.map(texto));
}

/** Primeira coluna da primeira linha, como texto ('' se não houver). */
export async function escalar(alvo: Alvo, sql: string, params?: unknown[]): Promise<string> {
  const l = await linhas(alvo, sql, params);
  return l[0]?.[0] ?? '';
}

/** Executa comando(s) sem resultado; exceção com a mensagem do MySQL se der erro. */
export async function rodar(alvo: Alvo, sql: string | string[], params?: unknown[]): Promise<RespostaSql> {
  const r = await executar(alvo, sql, { params });
  if (r.erro) throw new Error(r.erro);
  return r;
}
