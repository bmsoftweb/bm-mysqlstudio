/**
 * Peças de interface do app (o equivalente aos helpers de tela do uConnect.pas: SetupForm, AddHeader, NewToolBar,
 * AddSheetLines, FlatTabs...).
 *
 * - CAMPO: classes do campo de digitação padrão (28px de altura; a barra da esquerda vem do index.css)
 * - Botao: botão com a mesma altura dos campos (tom normal | primario | perigo)
 * - Dialogo: janela modal com faixa de título/subtítulo e rodapé de botões; Esc fecha; foco no 1º campo vazio
 * - LinhaCampo: linha de "planilha" dos diálogos (rótulo à esquerda, campo à direita, risco embaixo)
 * - Abas: faixa de abas plana (em cima ou embaixo do conteúdo)
 * - Barra / BotaoBarra / SeparadorBarra: barra de ferramentas
 * - Divisor + useTamanho: divisória arrastável entre painéis
 * - MenuContexto: menu popup (clique com o direito)
 * - Carregando: texto com spinner
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X, type LucideIcon } from 'lucide-react';

export const CAMPO = 'h-7 min-w-0 bg-fundo2 px-2 text-xs font-medium text-texto placeholder:text-texto2 placeholder:font-normal disabled:opacity-60';

// ==========================================================
// Botão
// ==========================================================
interface BotaoProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  tom?: 'normal' | 'primario' | 'perigo';
  icone?: LucideIcon;
  ocupado?: boolean;
}

const TONS = {
  normal: 'bg-blue-50 text-blue-800 hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-200 dark:hover:bg-blue-900/60',
  primario: 'bg-blue-600 text-white hover:bg-blue-700',
  perigo: 'bg-rose-600 text-white hover:bg-rose-700',
};

export const Botao: React.FC<BotaoProps> = ({ tom = 'normal', icone: Icone, ocupado, children, className = '', disabled, type = 'button', ...resto }) => (
  <button
    type={type}
    disabled={disabled || ocupado}
    className={`h-7 px-3 shrink-0 inline-flex items-center justify-center gap-1.5 rounded text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${TONS[tom]} ${className}`}
    {...resto}
  >
    {ocupado ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : Icone ? <Icone className="w-3.5 h-3.5" /> : null}
    {children}
  </button>
);

// ==========================================================
// Diálogo
// ==========================================================
interface DialogoProps {
  titulo: string;
  subtitulo?: React.ReactNode;
  /** Largura em px (padrão 520) */
  largura?: number;
  /** Altura fixa em px (diálogos com grade); sem ela, acompanha o conteúdo */
  altura?: number;
  onFechar: () => void;
  /** Botões do rodapé (alinhados à direita) */
  rodape?: React.ReactNode;
  /** Enter no formulário */
  onEnviar?: () => void;
  /** false: o diálogo não mexe no foco ao abrir */
  focar?: boolean;
  /** Clique fora e Esc não fecham (operação em andamento) */
  travado?: boolean;
  children: React.ReactNode;
}

/** Foco no primeiro campo vazio a preencher; se todos têm valor, no primeiro. */
function focarPrimeiroVazio(raiz: HTMLElement) {
  const campos = [...raiz.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')].filter(
    (c) => !c.disabled && !(c as HTMLInputElement).readOnly && c.type !== 'hidden' && c.type !== 'checkbox' && c.type !== 'file',
  );
  (campos.find((c) => c.tagName !== 'SELECT' && c.value === '') ?? campos[0])?.focus();
}

export const Dialogo: React.FC<DialogoProps> = ({ titulo, subtitulo, largura = 520, altura, onFechar, rodape, onEnviar, focar = true, travado, children }) => {
  const caixa = useRef<HTMLFormElement>(null);
  const fechar = useRef(onFechar);
  fechar.current = onFechar;

  useEffect(() => {
    if (focar && caixa.current) focarPrimeiroVazio(caixa.current);
  }, [focar]);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      // Só o diálogo de cima fecha (o último montado no body)
      if (e.key !== 'Escape' || travado) return;
      const abertos = document.querySelectorAll('[data-dialogo]');
      if (abertos[abertos.length - 1] === caixa.current?.parentElement) {
        e.stopPropagation();
        fechar.current();
      }
    };
    document.addEventListener('keydown', tecla);
    return () => document.removeEventListener('keydown', tecla);
  }, [travado]);

  return createPortal(
    <div data-dialogo className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-stone-950/60" onMouseDown={travado ? undefined : onFechar} aria-hidden="true" />
      <form
        ref={caixa}
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEnviar?.();
        }}
        style={{ width: largura, height: altura }}
        className="relative max-w-full max-h-full flex flex-col bg-fundo text-texto border border-borda2 rounded-lg shadow-2xl overflow-hidden"
      >
        <div className="shrink-0 flex items-start gap-3 px-4 py-2.5 bg-fundo2 border-b border-borda">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-bold">{titulo}</h3>
            {subtitulo && <div className="text-xs text-texto2 mt-0.5">{subtitulo}</div>}
          </div>
          {!travado && (
            <button type="button" onClick={onFechar} title="Fechar" className="p-1 -mr-1 rounded text-texto2 hover:bg-fundo3 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">{children}</div>
        {rodape && <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-2.5 border-t border-borda">{rodape}</div>}
        {/* Enter envia o formulário mesmo sem botão type=submit no rodapé */}
        {onEnviar && <button type="submit" className="hidden" />}
      </form>
    </div>,
    document.body,
  );
};

/** Linha de planilha dos diálogos: rótulo à esquerda, campo à direita, risco embaixo. */
export const LinhaCampo: React.FC<{ rotulo: string; larguraRotulo?: number; children: React.ReactNode; dica?: string }> = ({
  rotulo,
  larguraRotulo = 130,
  children,
  dica,
}) => (
  <label className="flex items-center gap-2 px-4 py-1 border-b border-borda min-h-9" title={dica}>
    <span style={{ width: larguraRotulo }} className="shrink-0 text-xs text-texto2">
      {rotulo}
    </span>
    <span className="flex-1 min-w-0 flex items-center gap-2">{children}</span>
  </label>
);

// ==========================================================
// Abas
// ==========================================================
export interface ItemAba {
  id: string;
  titulo: string;
  icone?: LucideIcon;
}

export const Abas: React.FC<{ abas: ItemAba[]; ativa: string; onTrocar: (id: string) => void; embaixo?: boolean; direita?: React.ReactNode }> = ({
  abas,
  ativa,
  onTrocar,
  embaixo,
  direita,
}) => (
  <div className={`shrink-0 flex items-stretch bg-fundo2 ${embaixo ? 'border-t' : 'border-b'} border-borda overflow-x-auto`}>
    {abas.map((a) => (
      <button
        key={a.id}
        type="button"
        onClick={() => onTrocar(a.id)}
        className={`h-7.5 px-3 flex items-center gap-1.5 text-xs whitespace-nowrap cursor-pointer ${embaixo ? 'border-t-2' : 'border-b-2'} ${
          a.id === ativa ? 'bg-fundo border-realce text-texto font-semibold' : 'border-transparent text-texto2 hover:bg-fundo3'
        }`}
      >
        {a.icone && <a.icone className="w-3.5 h-3.5" />}
        {a.titulo}
      </button>
    ))}
    {direita && <div className="ml-auto flex items-center px-2 text-xs text-texto2">{direita}</div>}
  </div>
);

// ==========================================================
// Barra de ferramentas
// ==========================================================
export const Barra: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`shrink-0 flex items-center gap-0.5 px-1 py-1 bg-fundo2 border-b border-borda ${className}`}>{children}</div>
);

interface BotaoBarraProps {
  icone: LucideIcon;
  /** Nome da ação: aparece na dica e, com texto = true, ao lado do ícone */
  titulo: string;
  texto?: boolean;
  onClick: () => void;
  disabled?: boolean;
  ativo?: boolean;
  /** Cor do ícone (classe Tailwind), ex.: text-emerald-600 */
  cor?: string;
}

export const BotaoBarra: React.FC<BotaoBarraProps> = ({ icone: Icone, titulo, texto, onClick, disabled, ativo, cor = '' }) => (
  <button
    type="button"
    title={titulo}
    onClick={onClick}
    disabled={disabled}
    className={`h-7 ${texto ? 'px-2' : 'w-7'} shrink-0 inline-flex items-center justify-center gap-1.5 rounded text-xs text-texto whitespace-nowrap cursor-pointer disabled:opacity-40 disabled:cursor-default ${
      ativo ? 'bg-selecao' : 'hover:bg-fundo3 disabled:hover:bg-transparent'
    }`}
  >
    <Icone className={`w-4 h-4 ${cor}`} />
    {texto && titulo}
  </button>
);

export const SeparadorBarra: React.FC = () => <span className="w-px h-5 mx-1 bg-borda2 shrink-0" />;

// ==========================================================
// Divisória arrastável
// ==========================================================
/**
 * Tamanho (px) de um painel redimensionável. sentido = 1: arrastar para a direita/baixo aumenta (painel antes da
 * divisória); -1: diminui (painel depois dela).
 */
export function useTamanho(inicial: number, minimo: number, sentido: 1 | -1 = 1) {
  const [tamanho, setTamanho] = useState(inicial);
  const aoArrastar = useCallback((delta: number) => setTamanho((t) => Math.max(minimo, t + delta * sentido)), [minimo, sentido]);
  return [tamanho, aoArrastar] as const;
}

/** vertical: barra em pé entre painéis lado a lado; senão, deitada entre painéis empilhados. */
export const Divisor: React.FC<{ vertical?: boolean; aoArrastar: (delta: number) => void }> = ({ vertical, aoArrastar }) => {
  const inicio = (e: React.PointerEvent) => {
    e.preventDefault();
    let ultimo = vertical ? e.clientX : e.clientY;
    const mover = (ev: PointerEvent) => {
      const atual = vertical ? ev.clientX : ev.clientY;
      aoArrastar(atual - ultimo);
      ultimo = atual;
    };
    const fim = () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', fim);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', fim);
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      onPointerDown={inicio}
      className={`shrink-0 bg-borda hover:bg-realce transition-colors ${vertical ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}`}
    />
  );
};

// ==========================================================
// Menu de contexto
// ==========================================================
export type ItemMenu =
  | '-'
  | {
      texto: string;
      icone?: LucideIcon;
      onClick: () => void;
      perigo?: boolean;
      desabilitado?: boolean;
      /** Atalho mostrado à direita (só o texto) */
      atalho?: string;
    };

/** Menu popup na posição (x, y) da tela. Fecha ao escolher, clicar fora, rolar ou Esc; perto do pé da tela, sobe. */
export const MenuContexto: React.FC<{ x: number; y: number; itens: ItemMenu[]; onFechar: () => void }> = ({ x, y, itens, onFechar }) => {
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const r = menu.current!.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const fora = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) onFechar();
    };
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    document.addEventListener('mousedown', fora);
    document.addEventListener('scroll', fora, true);
    document.addEventListener('keydown', tecla);
    window.addEventListener('blur', onFechar);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('scroll', fora, true);
      document.removeEventListener('keydown', tecla);
      window.removeEventListener('blur', onFechar);
    };
  }, [onFechar]);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[70] min-w-52 max-h-[90vh] overflow-y-auto py-1 rounded-md border border-borda2 bg-fundo text-texto shadow-xl"
    >
      {itens.map((it, i) =>
        it === '-' ? (
          <div key={i} className="my-1 border-t border-borda" />
        ) : (
          <button
            key={i}
            role="menuitem"
            type="button"
            disabled={it.desabilitado}
            onClick={() => {
              onFechar();
              it.onClick();
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs whitespace-nowrap cursor-pointer hover:bg-selecao disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent ${
              it.perigo ? 'text-rose-600 dark:text-rose-400' : ''
            }`}
          >
            <span className="w-4 h-4 shrink-0">{it.icone && <it.icone className="w-4 h-4" />}</span>
            <span className="flex-1">{it.texto}</span>
            {it.atalho && <span className="pl-6 text-texto2">{it.atalho}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
};

export const Carregando: React.FC<{ texto?: string }> = ({ texto = 'Carregando...' }) => (
  <div className="flex-1 flex items-center justify-center gap-2 p-6 text-xs text-texto2">
    <Loader2 className="w-4 h-4 animate-spin" />
    {texto}
  </div>
);
