/**
 * Avisos flutuantes (erro, alerta, sucesso) e diálogos imperativos (confirmar, pedir um texto), no lugar do
 * MessageDlg do app desktop. Quem desenha é o componente <Avisos /> (um só, no App).
 */
import type { ReactNode } from 'react';

export type TomAviso = 'erro' | 'alerta' | 'sucesso';

export interface Aviso {
  id: number;
  tom: TomAviso;
  mensagem: string;
}

export interface PedidoConfirmar {
  tipo: 'confirmar';
  titulo: string;
  mensagem: ReactNode;
  /** Texto do botão de confirmação (padrão: Excluir) */
  confirmar?: string;
  /** 'perigo' (vermelho, padrão) para excluir/descartar; 'normal' (azul) para as demais ações */
  tom?: 'perigo' | 'normal';
  resolver: (ok: boolean) => void;
}

export interface PedidoTexto {
  tipo: 'texto';
  titulo: string;
  subtitulo?: string;
  rotulo: string;
  /** Texto do botão (padrão: OK) */
  botao?: string;
  padrao?: string;
  /** Aviso para o valor digitado ('' = ok); o diálogo continua aberto até passar */
  validar?: (valor: string) => string;
  tom?: 'perigo' | 'normal';
  resolver: (valor: string | null) => void;
}

export type Pedido = PedidoConfirmar | PedidoTexto;

interface Estado {
  avisos: Aviso[];
  pedidos: Pedido[];
}

let estado: Estado = { avisos: [], pedidos: [] };
const ouvintes = new Set<() => void>();
let proximo = 1;

const mudar = (novo: Estado) => {
  estado = novo;
  ouvintes.forEach((f) => f());
};

export const lerAvisos = () => estado;
export const assinarAvisos = (f: () => void) => {
  ouvintes.add(f);
  return () => {
    ouvintes.delete(f);
  };
};

export const fecharAviso = (id: number) => mudar({ ...estado, avisos: estado.avisos.filter((a) => a.id !== id) });
export const fecharPedido = (p: Pedido) => mudar({ ...estado, pedidos: estado.pedidos.filter((x) => x !== p) });

function avisoNovo(tom: TomAviso, mensagem: string) {
  // O mesmo aviso repetido (ex.: várias consultas falhando igual) aparece uma vez só
  if (estado.avisos.some((a) => a.tom === tom && a.mensagem === mensagem)) return;
  mudar({ ...estado, avisos: [...estado.avisos, { id: proximo++, tom, mensagem }] });
}

/** Aviso no canto inferior direito, por cima de tudo: fecha no X ou sozinho em 10 s. */
export const avisar = {
  /** Aceita o que vier num catch: Error, texto... */
  erro: (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    if (m) avisoNovo('erro', m);
  },
  alerta: (mensagem: string) => avisoNovo('alerta', mensagem),
  sucesso: (mensagem: string) => avisoNovo('sucesso', mensagem),
};

/** Diálogo de confirmação: toda exclusão/remoção/descarte passa por ele. */
export function confirmar(p: Omit<PedidoConfirmar, 'tipo' | 'resolver'>): Promise<boolean> {
  return new Promise((resolver) => mudar({ ...estado, pedidos: [...estado.pedidos, { ...p, tipo: 'confirmar', resolver }] }));
}

/** Diálogo de um campo só (o AskName do desktop): o texto digitado, sem espaços nas pontas, ou null se cancelou. */
export function pedirTexto(p: Omit<PedidoTexto, 'tipo' | 'resolver'>): Promise<string | null> {
  return new Promise((resolver) => mudar({ ...estado, pedidos: [...estado.pedidos, { ...p, tipo: 'texto', resolver }] }));
}

/** "Descartar alterações não salvas?" */
export const confirmarDescarte = (mensagem = 'Há alterações não salvas. Descartar?') =>
  confirmar({ titulo: 'Descartar alterações?', mensagem, confirmar: 'Descartar' });
