/**
 * Grade de dados (o cxGrid do app desktop, uGrid.pas): cabeçalho com o tipo embaixo do nome, "(null)" em cinza
 * itálico, coluna indicadora, colunas redimensionáveis, rolagem virtual (só as linhas visíveis vão para a tela),
 * navegação por teclado e, se editável, edição na célula (texto, lista, sim/não, data).
 *
 * Os dados são de quem usa (linhas: Valor[][]): a grade avisa a alteração em onAlterar e não guarda nada.
 * Os índices de linha em todos os eventos são os de `linhas`, mesmo com a grade ordenada por uma coluna.
 *
 * Teclado: setas, Home/End, PageUp/PageDown, Tab; Enter ou F2 edita (ou é só digitar); Esc cancela;
 * Delete deixa a célula nula; Ctrl+C copia a célula.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronRight } from 'lucide-react';
import type { Valor } from '../lib/api';
import { base64ParaBytes, milhar, tipoBlob } from '../lib/db';
import { avisar } from '../lib/avisos';

export interface ColunaGrade {
  titulo: string;
  /** Segunda linha do cabeçalho, em cinza (o tipo da coluna) */
  subtitulo?: string;
  /** Largura em px (padrão 120); negativa = coluna escondida */
  largura?: number;
  alinhar?: 'esq' | 'dir' | 'centro';
  /**
   * Como a célula é editada: texto (padrão), check (sim/não: '1' ou ''), lista, data (dd/mm/aaaa), datahora;
   * 'nenhum' = só leitura. data/datahora também formatam a exibição (o valor continua aaaa-mm-dd).
   */
  editor?: 'texto' | 'check' | 'lista' | 'data' | 'datahora' | 'nenhum';
  /** Itens da lista */
  itens?: string[];
  /** Lista fechada: só os itens; senão aceita digitar outro valor */
  fixo?: boolean;
  dica?: string;
}

export interface GradeApi {
  focar(linha: number, coluna?: number): void;
  /** Confirma a célula em edição (o PostEdit do desktop); false se o valor digitado é inválido */
  confirmarEdicao(): boolean;
  foco(): { linha: number; coluna: number } | null;
}

export interface GradeProps {
  colunas: ColunaGrade[];
  linhas: Valor[][];
  editavel?: boolean;
  /** Célula a célula; sem ele, vale editavel e o editor da coluna */
  podeEditar?: (linha: number, coluna: number) => boolean;
  onAlterar?: (linha: number, coluna: number, valor: Valor) => void;
  onFoco?: (linha: number, coluna: number) => void;
  onDuploClique?: (linha: number, coluna: number) => void;
  /** Clique com o direito numa célula (a célula já ficou focada) */
  onMenu?: (e: React.MouseEvent, linha: number, coluna: number) => void;
  classeLinha?: (linha: number) => string | undefined;
  classeCelula?: (linha: number, coluna: number) => string | undefined;
  /** Clique no cabeçalho ordena (em memória). Não usar em grade editável paginada. */
  ordenavel?: boolean;
  /** Chegou perto do fim da rolagem: hora de buscar mais linhas */
  onFimDaRolagem?: () => void;
  /** Texto do rodapé no lugar de "Registro X de N" */
  rodape?: (posicao: number, total: number) => React.ReactNode;
  /** Conteúdo à direita no rodapé */
  rodapeExtra?: React.ReactNode;
  vazio?: string;
  /** Tecla Insert numa grade editável */
  onInserir?: () => void;
  className?: string;
}

const ALTURA = 28;
const LARGURA_PADRAO = 120;
const INDICADOR = 30;

/** aaaa-mm-dd[ hh:mm:ss] -> dd/mm/aaaa[ hh:mm:ss]; o que não for data fica como está. */
export function dataBr(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4]}` : v;
}

/** dd/mm/aaaa[ hh:mm[:ss]] (ou já aaaa-mm-dd) -> aaaa-mm-dd[ hh:mm:ss]; null se não for uma data válida. */
export function dataIso(v: string, comHora: boolean): string | null {
  const t = v.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(t);
  let a: string, mes: string, d: string;
  if (m) [, d, mes, a] = m;
  else {
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(t);
    if (!m) return null;
    [, a, mes, d] = m;
  }
  const dia = Number(d), mm = Number(mes), ano = Number(a);
  const zero = dia === 0 && mm === 0 && ano === 0; // 0000-00-00 do MySQL
  const data = new Date(ano, mm - 1, dia);
  if (!zero && (data.getFullYear() !== ano || data.getMonth() !== mm - 1 || data.getDate() !== dia)) return null;
  const p = (s: string | number) => String(s).padStart(2, '0');
  const iso = `${String(ano).padStart(4, '0')}-${p(mm)}-${p(dia)}`;
  if (!comHora) return m[4] ? null : iso;
  if (Number(m[4] ?? 0) > 23 || Number(m[5] ?? 0) > 59 || Number(m[6] ?? 0) >= 60) return null;
  const [segundos, fracao] = (m[6] ?? '0').split('.');
  return `${iso} ${p(m[4] ?? 0)}:${p(m[5] ?? 0)}:${p(segundos)}${fracao ? '.' + fracao : ''}`;
}

/** Texto da célula: binário vira "JPEG | 20.495 bytes"; quebras de linha viram espaço. */
export function textoCelula(v: Valor, col?: ColunaGrade): string {
  if (v === null) return '(null)';
  if (typeof v === 'object') {
    if (v.bin === null) return `Binário | ${milhar(v.bytes ?? 0)} bytes`;
    const bytes = Math.floor((v.bin.length * 3) / 4) - (v.bin.endsWith('==') ? 2 : v.bin.endsWith('=') ? 1 : 0);
    return `${tipoBlob(base64ParaBytes(v.bin.slice(0, 8)))} | ${milhar(bytes)} bytes`;
  }
  let s = String(v);
  if (col?.editor === 'data' || col?.editor === 'datahora') return dataBr(s);
  if (s.length > 400) s = s.slice(0, 400) + '…';
  return s.replace(/\r\n|\r|\n/g, ' ');
}

/** Valor como o usuário edita: '' para nulo; datas em dd/mm/aaaa. */
function textoEdicao(v: Valor, col: ColunaGrade): string {
  if (v === null || typeof v === 'object') return '';
  return col.editor === 'data' || col.editor === 'datahora' ? dataBr(String(v)) : String(v);
}

let medidor: CanvasRenderingContext2D | null = null;
function larguraTexto(s: string): number {
  medidor ??= document.createElement('canvas').getContext('2d');
  if (!medidor) return s.length * 7;
  medidor.font = '12px Jost, sans-serif';
  return medidor.measureText(s).width;
}

export const Grade = forwardRef<GradeApi, GradeProps>(function Grade(props, ref) {
  const { colunas, linhas, editavel, podeEditar, onAlterar, onFoco, onDuploClique, onMenu, classeLinha, classeCelula, ordenavel, onFimDaRolagem } = props;
  const area = useRef<HTMLDivElement>(null);
  const [rolagem, setRolagem] = useState(0);
  const [alturaArea, setAlturaArea] = useState(400);
  const [foco, setFoco] = useState<{ l: number; c: number } | null>(null);
  const [edicao, setEdicao] = useState<{ l: number; c: number; texto: string } | null>(null);
  const [ordem, setOrdem] = useState<{ c: number; desc: boolean } | null>(null);

  // Larguras: recomeçam do padrão quando o conjunto de colunas muda (outro resultado)
  const assinatura = colunas.map((c) => `${c.titulo}:${c.largura ?? ''}`).join('|');
  const [larguras, setLarguras] = useState<number[]>(() => colunas.map((c) => c.largura ?? LARGURA_PADRAO));
  const assinaturaAnterior = useRef(assinatura);
  if (assinaturaAnterior.current !== assinatura) {
    assinaturaAnterior.current = assinatura;
    setLarguras(colunas.map((c) => c.largura ?? LARGURA_PADRAO));
    setOrdem(null);
  }

  const visiveis = useMemo(() => colunas.map((_, i) => i).filter((i) => (larguras[i] ?? LARGURA_PADRAO) >= 0), [colunas, larguras]);
  const duasLinhas = colunas.some((c) => c.subtitulo);
  const alturaCabecalho = duasLinhas ? 40 : ALTURA;

  // Ordenação em memória: visao[posição na tela] = índice em linhas
  const visao = useMemo(() => {
    if (!ordem || !ordenavel) return null;
    const { c, desc } = ordem;
    const numerica = colunas[c]?.alinhar === 'dir';
    const chave = (v: Valor): string | number => (v === null ? '' : typeof v === 'object' ? '' : numerica && v !== '' && !isNaN(Number(v)) ? Number(v) : String(v));
    const idx = linhas.map((_, i) => i);
    idx.sort((a, b) => {
      const x = linhas[a][c], y = linhas[b][c];
      if (x === null || y === null) return (x === null ? (y === null ? 0 : -1) : 1) * (desc ? -1 : 1);
      const kx = chave(x), ky = chave(y);
      const r = typeof kx === 'number' && typeof ky === 'number' ? kx - ky : String(kx).localeCompare(String(ky), 'pt-BR', { numeric: true });
      return desc ? -r : r;
    });
    return idx;
  }, [ordem, ordenavel, linhas, colunas]);
  const linhaDe = useCallback((pos: number) => (visao ? visao[pos] : pos), [visao]);
  const posDe = useCallback((l: number) => (visao ? visao.indexOf(l) : l), [visao]);

  const total = linhas.length;
  const focoValido = foco && foco.l < total && foco.c < colunas.length ? foco : null;

  // Altura da área (para a rolagem virtual)
  useLayoutEffect(() => {
    const el = area.current!;
    const medir = () => setAlturaArea(el.clientHeight);
    medir();
    const obs = new ResizeObserver(medir);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const primeira = Math.max(0, Math.floor(rolagem / ALTURA) - 6);
  const ultima = Math.min(total, Math.ceil((rolagem + alturaArea) / ALTURA) + 6);

  // Pedido de mais linhas, uma vez por tamanho da lista
  const pedidoEm = useRef(-1);
  const aoRolar = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setRolagem(el.scrollTop);
    if (onFimDaRolagem && el.scrollTop + el.clientHeight > el.scrollHeight - 300 && pedidoEm.current !== total) {
      pedidoEm.current = total;
      onFimDaRolagem();
    }
  };

  const editaCelula = (l: number, c: number) => {
    const col = colunas[c];
    if (!editavel || !col || col.editor === 'nenhum') return false;
    return podeEditar ? podeEditar(l, c) : true;
  };

  const mostrar = (l: number, c: number) => {
    const el = area.current;
    if (!el) return;
    const y = posDe(l) * ALTURA;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ALTURA > el.scrollTop + el.clientHeight - alturaCabecalho) el.scrollTop = y + ALTURA - el.clientHeight + alturaCabecalho;
    let x = INDICADOR;
    for (const i of visiveis) {
      if (i === c) break;
      x += larguras[i];
    }
    const w = larguras[c] ?? 0;
    if (x - INDICADOR < el.scrollLeft) el.scrollLeft = x - INDICADOR;
    else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
  };

  const focar = (l: number, c: number, rolar = true) => {
    if (l < 0 || l >= total || !colunas[c]) return;
    setFoco({ l, c });
    if (rolar) mostrar(l, c);
    onFoco?.(l, c);
  };

  /** false: valor inválido, a edição continua aberta */
  const confirmar = (): boolean => {
    if (!edicao) return true;
    const col = colunas[edicao.c];
    const original = linhas[edicao.l]?.[edicao.c] ?? null;
    let v: Valor = edicao.texto;
    if (col.editor === 'data' || col.editor === 'datahora') {
      if (edicao.texto.trim() === '') v = null;
      else {
        const iso = dataIso(edicao.texto, col.editor === 'datahora');
        if (!iso) {
          avisar.alerta(col.editor === 'data' ? 'Data inválida. Use dd/mm/aaaa.' : 'Data inválida. Use dd/mm/aaaa hh:mm:ss.');
          return false;
        }
        v = iso;
      }
    }
    setEdicao(null);
    const igual = v === original || (original === null && v === '') || (original !== null && typeof original !== 'object' && String(original) === v);
    if (!igual && edicao.l < total) onAlterar?.(edicao.l, edicao.c, v);
    return true;
  };

  const editar = (l: number, c: number, inicial?: string) => {
    if (!editaCelula(l, c)) return;
    const col = colunas[c];
    if (col.editor === 'check') {
      onAlterar?.(l, c, textoEdicao(linhas[l][c], col) === '1' ? '' : '1');
      return;
    }
    setEdicao({ l, c, texto: inicial ?? textoEdicao(linhas[l][c], col) });
  };

  useImperativeHandle(ref, () => ({
    focar: (linha, coluna) => {
      focar(linha, coluna ?? focoValido?.c ?? visiveis[0] ?? 0);
      area.current?.focus();
    },
    confirmarEdicao: confirmar,
    foco: () => (focoValido ? { linha: focoValido.l, coluna: focoValido.c } : null),
  }));

  const mover = (dl: number, dc: number) => {
    if (!total || !visiveis.length) return;
    const atual = focoValido ?? { l: linhaDe(0), c: visiveis[0] };
    let pos = posDe(atual.l) + dl;
    let ic = visiveis.indexOf(atual.c) + dc;
    // Tab na última coluna passa para a próxima linha (e Shift+Tab na primeira, para a anterior)
    if (ic >= visiveis.length && Math.abs(dc) === 1 && dl === 0) {
      if (pos + 1 < total) {
        ic = 0;
        pos++;
      } else ic = visiveis.length - 1;
    } else if (ic < 0 && Math.abs(dc) === 1 && dl === 0) {
      if (pos > 0) {
        ic = visiveis.length - 1;
        pos--;
      } else ic = 0;
    }
    pos = Math.max(0, Math.min(total - 1, pos));
    ic = Math.max(0, Math.min(visiveis.length - 1, ic));
    focar(linhaDe(pos), visiveis[ic]);
  };

  const aoTeclar = (e: React.KeyboardEvent) => {
    if (edicao) return; // as teclas da edição são do editor
    const pagina = Math.max(1, Math.floor((alturaArea - alturaCabecalho) / ALTURA) - 1);
    const f = focoValido;
    switch (e.key) {
      case 'ArrowDown': mover(1, 0); break;
      case 'ArrowUp': mover(-1, 0); break;
      case 'ArrowRight': mover(0, 1); break;
      case 'ArrowLeft': mover(0, -1); break;
      case 'PageDown': mover(pagina, 0); break;
      case 'PageUp': mover(-pagina, 0); break;
      case 'Home': if (e.ctrlKey) mover(-total, -colunas.length * 2); else mover(0, -colunas.length * 2); break;
      case 'End': if (e.ctrlKey) mover(total, colunas.length * 2); else mover(0, colunas.length * 2); break;
      case 'Tab': {
        // Só sai da grade depois da última célula (ou antes da primeira)
        if (!f || !total) return;
        const naPonta = e.shiftKey
          ? posDe(f.l) === 0 && f.c === visiveis[0]
          : posDe(f.l) === total - 1 && f.c === visiveis[visiveis.length - 1];
        if (naPonta) return;
        mover(0, e.shiftKey ? -1 : 1);
        break;
      }
      case 'Enter':
      case 'F2':
        if (!f || !editaCelula(f.l, f.c)) return;
        editar(f.l, f.c);
        break;
      case ' ':
        if (!f || colunas[f.c]?.editor !== 'check' || !editaCelula(f.l, f.c)) return;
        editar(f.l, f.c);
        break;
      case 'Delete':
        if (!f || !editaCelula(f.l, f.c) || linhas[f.l][f.c] === null) return;
        onAlterar?.(f.l, f.c, colunas[f.c].editor === 'check' ? '' : null);
        break;
      case 'Insert':
        if (!editavel || !props.onInserir) return;
        props.onInserir();
        break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && f) {
          const v = linhas[f.l][f.c];
          void navigator.clipboard?.writeText(v === null ? '' : typeof v === 'object' ? textoCelula(v) : String(v));
          break;
        }
        // Digitar numa célula editável já começa a edição com o que foi digitado
        if (f && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && editaCelula(f.l, f.c) && colunas[f.c].editor !== 'check') {
          const col = colunas[f.c];
          if (col.editor === 'lista' && col.fixo) editar(f.l, f.c);
          else editar(f.l, f.c, e.key);
          break;
        }
        return;
    }
    e.preventDefault();
  };

  // Redimensionar: congela as larguras atuais e aplica o arrasto só na coluna puxada (mínimo 50px)
  const redimensionar = (e: React.PointerEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = larguras[c];
    const moverAlca = (ev: PointerEvent) => setLarguras((ls) => ls.map((w, i) => (i === c ? Math.max(50, w0 + ev.clientX - x0) : w)));
    const fim = () => {
      window.removeEventListener('pointermove', moverAlca);
      window.removeEventListener('pointerup', fim);
    };
    window.addEventListener('pointermove', moverAlca);
    window.addEventListener('pointerup', fim);
  };

  /** Duplo clique na alça: melhor largura para o conteúdo (cabeçalho e as primeiras 500 linhas). */
  const melhorLargura = (c: number) => {
    let w = Math.max(larguraTexto(colunas[c].titulo), larguraTexto(colunas[c].subtitulo ?? ''));
    for (let i = 0; i < Math.min(total, 500); i++) w = Math.max(w, larguraTexto(textoCelula(linhas[i][c], colunas[c])));
    setLarguras((ls) => ls.map((x, i) => (i === c ? Math.min(600, Math.max(50, Math.ceil(w) + 18)) : x)));
  };

  const larguraTotal = INDICADOR + visiveis.reduce((n, i) => n + larguras[i], 0);
  const posicaoFoco = focoValido ? posDe(focoValido.l) + 1 : 0;

  const alinhamento = (col: ColunaGrade) => (col.alinhar === 'dir' ? 'text-right' : col.alinhar === 'centro' || col.editor === 'check' ? 'text-center' : 'text-left');

  const celula = (l: number, c: number) => {
    const col = colunas[c];
    const v = linhas[l][c];
    const focada = focoValido?.l === l && focoValido.c === c;
    const emEdicao = edicao?.l === l && edicao.c === c;
    return (
      <td
        key={c}
        onMouseDown={(e) => {
          if (emEdicao) return;
          if (edicao && !confirmar()) return e.preventDefault();
          focar(l, c, false);
        }}
        onClick={() => col.editor === 'check' && editaCelula(l, c) && editar(l, c)}
        onDoubleClick={() => (editaCelula(l, c) && col.editor !== 'check' ? editar(l, c) : onDuploClique?.(l, c))}
        onContextMenu={(e) => {
          if (!onMenu) return;
          e.preventDefault();
          focar(l, c, false);
          onMenu(e, l, c);
        }}
        className={`relative h-7 px-2 border-b border-r border-borda overflow-hidden whitespace-nowrap text-ellipsis ${alinhamento(col)} ${
          focada ? 'outline outline-2 -outline-offset-2 outline-realce' : ''
        } ${classeCelula?.(l, c) ?? ''}`}
      >
        {emEdicao ? (
          <EditorCelula
            col={col}
            texto={edicao.texto}
            onTexto={(texto) => setEdicao({ l, c, texto })}
            onConfirmar={(sair) => {
              if (!confirmar()) return;
              area.current?.focus();
              if (sair) mover(0, sair);
            }}
            onCancelar={() => {
              setEdicao(null);
              area.current?.focus();
            }}
          />
        ) : col.editor === 'check' ? (
          <span className={`inline-flex w-4 h-4 items-center justify-center rounded-sm border align-middle ${v === '1' || v === 1 ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-borda2'}`}>
            {(v === '1' || v === 1) && <Check className="w-3 h-3" />}
          </span>
        ) : v === null ? (
          <span className="italic text-stone-400 dark:text-stone-500">(null)</span>
        ) : (
          textoCelula(v, col)
        )}
      </td>
    );
  };

  return (
    <div className={`flex-1 min-h-0 min-w-0 flex flex-col bg-fundo text-xs ${props.className ?? ''}`}>
      <div
        ref={area}
        tabIndex={0}
        onScroll={aoRolar}
        onKeyDown={aoTeclar}
        className="flex-1 min-h-0 overflow-auto outline-none"
      >
        <table style={{ width: larguraTotal, tableLayout: 'fixed' }} className="border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: INDICADOR }} />
            {visiveis.map((i) => (
              <col key={i} style={{ width: larguras[i] }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={{ height: alturaCabecalho }} className="sticky top-0 left-0 z-20 bg-fundo2 border-b border-r border-borda" />
              {visiveis.map((i) => {
                const col = colunas[i];
                return (
                  <th
                    key={i}
                    title={col.dica}
                    onClick={() => ordenavel && setOrdem((o) => (o?.c === i ? (o.desc ? null : { c: i, desc: true }) : { c: i, desc: false }))}
                    style={{ height: alturaCabecalho }}
                    className={`sticky top-0 z-10 px-2 bg-fundo2 border-b border-r border-borda font-semibold text-center overflow-hidden whitespace-nowrap text-ellipsis select-none ${ordenavel ? 'cursor-pointer' : ''}`}
                  >
                    <div className="overflow-hidden text-ellipsis">
                      {col.titulo}
                      {ordem?.c === i && (ordem.desc ? ' ▼' : ' ▲')}
                    </div>
                    {duasLinhas && <div className="text-[11px] font-normal text-texto2 overflow-hidden text-ellipsis">{col.subtitulo || ' '}</div>}
                    <span
                      draggable={false}
                      onPointerDown={(e) => redimensionar(e, i)}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        melhorLargura(i);
                      }}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-realce/40"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {primeira > 0 && (
              <tr style={{ height: primeira * ALTURA }}>
                <td colSpan={visiveis.length + 1} />
              </tr>
            )}
            {Array.from({ length: Math.max(0, ultima - primeira) }, (_, k) => {
              const l = linhaDe(primeira + k);
              const atual = focoValido?.l === l;
              return (
                <tr key={primeira + k} className={`group ${atual ? 'bg-selecao2' : 'bg-fundo hover:bg-fundo2'} ${classeLinha?.(l) ?? ''}`}>
                  <td
                    onMouseDown={() => focar(l, focoValido?.c ?? visiveis[0] ?? 0, false)}
                    className="sticky left-0 z-[5] h-7 bg-fundo2 border-b border-r border-borda text-center"
                  >
                    <ChevronRight className={`inline w-3.5 h-3.5 ${atual ? 'text-realce' : 'text-transparent group-hover:text-borda2'}`} />
                  </td>
                  {visiveis.map((c) => celula(l, c))}
                </tr>
              );
            })}
            {ultima < total && (
              <tr style={{ height: (total - ultima) * ALTURA }}>
                <td colSpan={visiveis.length + 1} />
              </tr>
            )}
          </tbody>
        </table>
        {total === 0 && <div className="p-6 text-center text-texto2">{props.vazio ?? 'Nenhum registro'}</div>}
      </div>
      <div className="shrink-0 h-6 flex items-center gap-3 px-2 bg-fundo2 border-t border-borda text-[11px] text-texto2">
        <span>{props.rodape ? props.rodape(posicaoFoco, total) : `Registro ${milhar(posicaoFoco)} de ${milhar(total)}`}</span>
        <span className="ml-auto flex items-center gap-3">{props.rodapeExtra}</span>
      </div>
    </div>
  );
});

// ==========================================================
// Editor da célula
// ==========================================================
interface EditorCelulaProps {
  col: ColunaGrade;
  texto: string;
  onTexto: (t: string) => void;
  /** sair: 0 fica na célula (Enter, perda de foco), 1 vai para a próxima (Tab), -1 para a anterior (Shift+Tab) */
  onConfirmar: (sair: number) => void;
  onCancelar: () => void;
}

const EDITOR = 'sem-barra absolute inset-0 w-full h-full px-2 bg-fundo text-texto text-xs outline outline-2 -outline-offset-2 outline-realce';

const EditorCelula: React.FC<EditorCelulaProps> = ({ col, texto, onTexto, onConfirmar, onCancelar }) => {
  const campo = useRef<HTMLInputElement & HTMLSelectElement>(null);
  const nativo = useRef<HTMLInputElement>(null);
  const encerrado = useRef(false);
  const idLista = useRef(`lista-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const el = campo.current;
    if (!el) return;
    el.focus();
    // Começou digitando (um caractere): cursor no fim; abriu com Enter/F2/duplo clique: tudo selecionado
    if (el instanceof HTMLInputElement) {
      if (texto.length === 1) el.setSelectionRange(1, 1);
      else el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tecla = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      encerrado.current = true;
      onConfirmar(0);
      encerrado.current = false; // valor inválido: a edição continua
    } else if (e.key === 'Tab') {
      e.preventDefault();
      encerrado.current = true;
      onConfirmar(e.shiftKey ? -1 : 1);
      encerrado.current = false;
    } else if (e.key === 'Escape') {
      encerrado.current = true;
      onCancelar();
    }
  };
  const sair = () => {
    if (!encerrado.current) onConfirmar(0);
  };
  const alinhar = col.alinhar === 'dir' ? 'text-right' : col.alinhar === 'centro' ? 'text-center' : '';

  if (col.editor === 'lista' && col.fixo) {
    const itens = col.itens ?? [];
    return (
      <select ref={campo} value={texto} onChange={(e) => onTexto(e.target.value)} onKeyDown={tecla} onBlur={sair} onMouseDown={(e) => e.stopPropagation()} className={EDITOR}>
        {!itens.includes(texto) && <option value={texto}>{texto}</option>}
        {itens.map((it) => (
          <option key={it} value={it}>
            {it}
          </option>
        ))}
      </select>
    );
  }

  const data = col.editor === 'data' || col.editor === 'datahora';
  return (
    <>
      <input
        ref={campo}
        value={texto}
        list={col.editor === 'lista' ? idLista.current : undefined}
        placeholder={col.editor === 'data' ? 'dd/mm/aaaa' : col.editor === 'datahora' ? 'dd/mm/aaaa hh:mm:ss' : undefined}
        onChange={(e) => onTexto(e.target.value)}
        onKeyDown={tecla}
        onBlur={(e) => {
          // O clique no calendário não encerra a edição
          if (e.relatedTarget && (e.relatedTarget as HTMLElement).dataset?.calendario) return;
          sair();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`${EDITOR} ${alinhar} ${data ? 'pr-7' : ''}`}
      />
      {col.editor === 'lista' && (
        <datalist id={idLista.current}>
          {(col.itens ?? []).map((it) => (
            <option key={it} value={it} />
          ))}
        </datalist>
      )}
      {data && (
        <>
          {/* Calendário do navegador sem mostrar o campo nativo aaaa-mm-dd: só o seletor é aberto */}
          <input
            ref={nativo}
            type={col.editor === 'data' ? 'date' : 'datetime-local'}
            tabIndex={-1}
            className="sem-barra absolute right-0 bottom-0 w-0 h-0 opacity-0 pointer-events-none"
            onChange={(e) => {
              if (!e.target.value) return;
              onTexto(dataBr(e.target.value.replace('T', ' ')) + (col.editor === 'datahora' && e.target.value.length === 16 ? ':00' : ''));
              campo.current?.focus();
            }}
          />
          <button
            type="button"
            data-calendario="1"
            tabIndex={-1}
            title="Abrir o calendário"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              try {
                nativo.current?.showPicker();
              } catch {
                // navegador sem showPicker: fica só a digitação
              }
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 z-10 p-0.5 rounded text-texto2 hover:text-realce cursor-pointer"
          >
            <CalendarDays className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </>
  );
};
