import { UsuarioSessao } from './api';

/**
 * Sessão do app e opção "Lembrar neste dispositivo" (como no crmWeb, sem guardar a senha):
 * marcada, a sessão fica no localStorage e o e-mail vem preenchido no próximo login; desmarcada, fica no
 * sessionStorage e termina ao fechar o navegador. A sessão guarda só o token assinado pelo servidor.
 */
const SESSAO = 'mysqlstudio_sessao';
const EMAIL = 'mysqlstudio_email';
const TEMA = 'mysqlstudio_tema';

export interface Sessao {
  usuario: UsuarioSessao;
  token: string;
}

/** O acesso ao storage pode lançar exceção (modo privado, bloqueio de cookies) */
function seguro<T>(fn: () => T, padrao: T): T {
  try {
    return fn();
  } catch {
    return padrao;
  }
}

export function lerSessao(): Sessao | null {
  return seguro(() => {
    const bruto = localStorage.getItem(SESSAO) ?? sessionStorage.getItem(SESSAO);
    const s = bruto ? (JSON.parse(bruto) as Sessao) : null;
    return s?.token && s.usuario ? s : null;
  }, null);
}

export function salvarSessao(sessao: Sessao, lembrar: boolean) {
  seguro(() => {
    (lembrar ? localStorage : sessionStorage).setItem(SESSAO, JSON.stringify(sessao));
    (lembrar ? sessionStorage : localStorage).removeItem(SESSAO);
    if (lembrar) localStorage.setItem(EMAIL, sessao.usuario.email);
    else localStorage.removeItem(EMAIL);
  }, undefined);
}

export function limparSessao() {
  seguro(() => {
    localStorage.removeItem(SESSAO);
    sessionStorage.removeItem(SESSAO);
  }, undefined);
}

export const emailLembrado = () => seguro(() => localStorage.getItem(EMAIL) || '', '');

// ==========================================================
// Tema claro/escuro
// ==========================================================
export type Tema = 'light' | 'dark';

export function temaInicial(): Tema {
  return seguro(() => {
    const salvo = localStorage.getItem(TEMA);
    if (salvo === 'light' || salvo === 'dark') return salvo;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }, 'light');
}

export function aplicarTema(tema: Tema) {
  document.documentElement.classList.toggle('dark', tema === 'dark');
  seguro(() => localStorage.setItem(TEMA, tema), undefined);
}
