/**
 * O que as abas e os diálogos usam da janela principal (o frmMain do desktop): abrir outras abas, a Saída,
 * recarregar a árvore. E o registro de cada aba na barra principal (Executar, Salvar, alterações pendentes).
 */
import { createContext, useContext, useEffect, useRef } from 'react';
import type { Conexao } from '../lib/api';

export type PastaArvore = 'tables' | 'views' | 'procs' | 'funcs' | 'triggers';

/** Aba aberta na área de documentos. */
export type Aba = { id: string; titulo: string } & (
  | { tipo: 'consulta'; conexao: number; banco: string; sql: string; executar: boolean; arquivo?: string }
  /** tabela = '': tabela nova. dados: abre na aba Dados (senão Colunas) */
  | { tipo: 'tabela'; conexao: number; banco: string; tabela: string; dados: boolean }
  /** nome = '': view nova */
  | { tipo: 'view'; conexao: number; banco: string; nome: string }
  /** nome = '': rotina nova */
  | { tipo: 'rotina'; conexao: number; banco: string; nome: string; funcao: boolean }
  | { tipo: 'servidor'; conexao: number; qual: 'sessoes' | 'variaveis' | 'status' }
  | { tipo: 'seguranca'; conexao: number }
  /** dados: comparação de dados (senão de esquemas); conexao/banco: origem sugerida */
  | { tipo: 'comparacao'; dados: boolean; conexao?: number; banco?: string }
);

/** O que a aba ativa oferece à barra e aos atalhos da janela principal. Tudo opcional. */
export interface ControleAba {
  /** Alterações não salvas: fechar a aba pergunta antes */
  temAlteracoes?: () => boolean;
  /** Consulta em execução: a aba não fecha */
  rodando?: () => boolean;
  /** Executar (F9): na consulta roda o SQL; nas telas de dados e do servidor, recarrega */
  executar?: () => void;
  /** Executar a instrução do cursor (Ctrl+Enter) */
  executarAtual?: () => void;
  parar?: () => void;
  formatar?: () => void;
  /** Salvar (Ctrl+S) */
  salvar?: () => void;
  salvarComo?: () => void;
  exportarCsv?: () => void;
}

export interface AppApi {
  conexoes: Conexao[];
  conexao(id: number): Conexao | undefined;
  /** Linha na Saída, com a hora */
  log(texto: string): void;
  abrirConsulta(conexao: number, banco: string, sql: string, executar?: boolean): void;
  /** tabela = '': nova. dados = true: abre na aba Dados. Se já estiver aberta, só volta para ela. */
  abrirTabela(conexao: number, banco: string, tabela: string, dados?: boolean): void;
  abrirView(conexao: number, banco: string, nome: string): void;
  abrirRotina(conexao: number, banco: string, nome: string, funcao: boolean): void;
  /** Telas do servidor: sessões, variáveis, status e usuários e privilégios */
  abrirServidor(conexao: number, qual: 'sessoes' | 'variaveis' | 'status' | 'usuarios'): void;
  /** Troca o título (e os dados) de uma aba: ex. tabela nova que acabou de ser criada */
  alterarAba(id: string, mudancas: Partial<Aba>): void;
  /** Fecha sem perguntar */
  fecharAba(id: string): void;
  /** Fecha, sem perguntar, as abas do que deixou de existir: a tabela, ou o banco inteiro (sem tabela) */
  fecharAbasDoObjeto(conexao: number, banco: string, tabela?: string): void;
  /** Recarrega na árvore a pasta do banco (ou, sem pasta, o banco; sem banco, a conexão), se estiver aberta */
  atualizarArvore(conexao: number, banco?: string, pasta?: PastaArvore): void;
}

export const AppContexto = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const app = useContext(AppContexto);
  if (!app) throw new Error('useApp fora do App');
  return app;
}

/** Controles das abas abertas, pelo id da aba */
export const controles = new Map<string, ControleAba>();

/**
 * Registra o que a aba oferece à janela principal. O objeto pode ser novo a cada render: a janela chama sempre
 * a versão mais recente.
 */
export function useControleAba(id: string, controle: ControleAba) {
  const atual = useRef(controle);
  atual.current = controle;
  useEffect(() => {
    const proxy: ControleAba = {};
    for (const k of ['temAlteracoes', 'rodando', 'executar', 'executarAtual', 'parar', 'formatar', 'salvar', 'salvarComo', 'exportarCsv'] as const) {
      Object.defineProperty(proxy, k, { get: () => atual.current[k], enumerable: true });
    }
    controles.set(id, proxy);
    return () => {
      controles.delete(id);
    };
  }, [id]);
}

/** Nomes e cores do ambiente da conexão (produção em vermelho, para não confundir com teste) */
export const AMBIENTES = ['Nenhum', 'Desenvolvimento', 'Homologação', 'Produção'];
export const COR_AMBIENTE = ['', 'text-emerald-600 dark:text-emerald-400', 'text-amber-600 dark:text-amber-400', 'text-rose-600 dark:text-rose-400 font-bold'];
