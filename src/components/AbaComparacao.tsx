/**
 * Comparação de esquemas e de dados (uCompare.pas; a lógica fica em compareLogic.ts). No desktop era uma janela
 * separada; aqui é uma aba: em cima a origem (modelo) e o destino (que será alterado), no meio a lista do
 * resultado e embaixo as diferenças do item escolhido e o script de sincronização.
 *
 * Esquemas: DDL lado a lado, com as linhas que não existem do outro lado em vermelho; o script (editável) roda
 * direto no destino ou é salvo. Dados: registros lado a lado por situação, buscados nos dois bancos de PAGE_SIZE em
 * PAGE_SIZE conforme a rolagem; o script na tela é só a prévia, quem sincroniza é o assistente (Sincronizar.tsx).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alvo, Valor, linhas } from '../lib/api';
import { ARQ_SQL, SQL_BANCOS, comBanco, criarArquivo, milhar } from '../lib/db';
import {
  Andamento,
  CompareOptions,
  DiffSt,
  MapTable,
  OnlySrc,
  OnlyTgt,
  RecDiff,
  RecSame,
  RecSrc,
  RecTgt,
  RecView,
  Same,
  SchemaObj,
  TableDiff,
  changes,
  compareData,
  compareSchemas,
  dataScriptHeader,
  loadRecords,
  mapTables,
  newCompareOptions,
  newSyncOptions,
  rowLines,
  schemaScript,
  structDiff,
  writeDataScript,
} from '../lib/compareLogic';
import { runScript } from '../lib/backup';
import { avisar, confirmar } from '../lib/avisos';
import { AMBIENTES, Aba, COR_AMBIENTE, useApp, useControleAba } from '../app/contexto';
import { Abas, Botao, CAMPO, Divisor, ItemAba, LinhaCampo, useTamanho } from './ui';
import { ColunaGrade, Grade, GradeApi } from './Grade';
import { EditorSql } from './EditorSql';
import { Toggle } from './Toggle';
import { DialogoMapeamento, DialogoOpcoes } from './ComparacaoOpcoes';
import { Sincronizar } from './Sincronizar';
import { mensagemDe } from './AbaRotina';

const REC_TABS = ['Todos', OnlySrc, 'Diferentes', OnlyTgt, 'Iguais'];
const REC_STATES = [RecSrc + RecDiff + RecTgt + RecSame, RecSrc, RecDiff, RecTgt, RecSame];
const PAGE_SIZE = 200;
// ponytail: a grade mostra até 1 milhão de registros por aba (as chaves ficam na memória); paginar as chaves se
// precisar ver mais.
const MAX_RECS = 1_000_000;
const PREVIEW_BYTES = 1024 * 1024; // o editor fica lento com dezenas de MB

const COLUNAS_DADOS: ColunaGrade[] = [
  { titulo: '', largura: 30, editor: 'check', dica: 'Entra no script de sincronização' },
  { titulo: 'Tabela', largura: 260, editor: 'nenhum' },
  { titulo: 'Só na origem', largura: 110, alinhar: 'dir', editor: 'nenhum' },
  { titulo: 'Só no destino', largura: 110, alinhar: 'dir', editor: 'nenhum' },
  { titulo: 'Diferentes', largura: 110, alinhar: 'dir', editor: 'nenhum' },
  { titulo: 'Iguais', largura: 110, alinhar: 'dir', editor: 'nenhum' },
  { titulo: 'Obs.', largura: 260, editor: 'nenhum' },
];
const COLUNAS_ESQUEMA: ColunaGrade[] = [
  { titulo: '', largura: 30, editor: 'check', dica: 'Entra no script de sincronização' },
  { titulo: 'Tipo', largura: 110, editor: 'nenhum' },
  { titulo: 'Objeto', largura: 260, editor: 'nenhum' },
  { titulo: 'Situação', largura: 110, editor: 'nenhum' },
];

/** SameText/MatchText do Delphi */
const mesmoTexto = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ==========================================================
// Seletor de conexão e banco (o TConnPicker)
// ==========================================================
/** conexao 0 = nenhuma; banco '' = nenhum (ou os bancos não puderam ser lidos) */
interface Lado {
  conexao: number;
  banco: string;
}

/** Duas linhas em formato planilha (conexão e banco), como nos modais. */
const SeletorConexao: React.FC<{ lado: string; valor: Lado; onMudar: (v: Lado) => void }> = ({ lado, valor, onMudar }) => {
  const app = useApp();
  const [bancos, setBancos] = useState<string[]>([]);
  const pedido = useRef(0);
  const cx = app.conexao(valor.conexao);

  // Lista os bancos da conexão escolhida (a senha, se não estiver salva, é pedida pela camada api.ts).
  const escolher = async (conexao: number, banco: string) => {
    const vez = ++pedido.current;
    setBancos([]);
    onMudar({ conexao, banco: '' });
    const c = app.conexao(conexao);
    if (!c) return;
    try {
      const lista = (await linhas({ conexao }, SQL_BANCOS)).map((l) => l[0]);
      if (vez !== pedido.current) return; // outra conexão foi escolhida depois desta
      setBancos(lista);
      const db = banco || c.banco;
      onMudar({ conexao, banco: lista.find((b) => mesmoTexto(b, db)) ?? lista[0] ?? '' });
    } catch (e) {
      if (vez === pedido.current) avisar.erro(e);
    }
  };

  useEffect(() => {
    if (valor.conexao) void escolher(valor.conexao, valor.banco);
    // Só ao abrir, com a conexão e o banco sugeridos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <LinhaCampo rotulo={`Conexão de ${lado}:`}>
        <select value={cx ? valor.conexao : ''} onChange={(e) => void escolher(Number(e.target.value), '')} className={`${CAMPO} w-60 shrink-0`}>
          <option value="" hidden />
          {app.conexoes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nome}
            </option>
          ))}
        </select>
        {/* usuário@servidor:porta, com a cor do ambiente */}
        {cx && (
          <span className={`min-w-0 truncate text-xs whitespace-pre ${COR_AMBIENTE[cx.ambiente] || 'text-texto2'}`}>
            {`${cx.usuario}@${cx.servidor}:${cx.porta}` + (cx.ambiente > 0 ? `  [${AMBIENTES[cx.ambiente]}]` : '')}
          </span>
        )}
      </LinhaCampo>
      <LinhaCampo rotulo={`Banco de ${lado}:`}>
        <select value={valor.banco} onChange={(e) => onMudar({ conexao: valor.conexao, banco: e.target.value })} className={`${CAMPO} w-60 shrink-0`}>
          {bancos.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </LinhaCampo>
    </>
  );
};

// ==========================================================
// DDL com as diferenças em vermelho (o DdlBox + Highlight)
// ==========================================================
const normLinha = (s: string) => s.trim().replace(/,+$/, '');

/** Destaca em vermelho as linhas que não existem do outro lado. */
const CaixaDdl = React.memo(function CaixaDdl({ texto, outro, temOutro, largura }: { texto: string; outro: string; temOutro: boolean; largura?: number }) {
  const doOutro = new Set(outro.split('\n').map(normLinha));
  return (
    <pre style={{ width: largura }} className={`${largura ? 'shrink-0' : 'flex-1'} min-w-0 min-h-0 overflow-auto p-2 bg-fundo font-mono text-[13px] leading-snug text-texto`}>
      {texto !== '' &&
        texto.split('\n').map((l, i) => (
          <span key={i} className={temOutro && !doOutro.has(normLinha(l)) ? 'font-bold text-red-600 dark:text-red-400' : undefined}>
            {l + '\n'}
          </span>
        ))}
    </pre>
  );
});

// ==========================================================
// A aba
// ==========================================================
/** Resultado da última comparação: o que a lista, as diferenças e o script mostram. */
interface Resultado {
  /** Número da comparação: refaz a grade dos registros */
  n: number;
  /** Origem e destino, já com o banco (o FPendingSrc e o FScriptParams do Pascal) */
  a1: Alvo;
  db1: string;
  a2: Alvo;
  db2: string;
  /** Esquemas */
  objs: SchemaObj[];
  /** Dados */
  diffs: TableDiff[];
  header: string;
  /** As opções com que a comparação foi feita (as da tela podem ter mudado depois) */
  opts: CompareOptions;
}

export const AbaComparacao: React.FC<{ aba: Extract<Aba, { tipo: 'comparacao' }>; ativa: boolean }> = ({ aba }) => {
  const app = useApp();
  const dados = aba.dados;

  // Como no desktop, os dois lados começam na conexão e no banco sugeridos: o usuário troca o destino.
  const [origem, setOrigem] = useState<Lado>({ conexao: aba.conexao ?? 0, banco: aba.banco ?? '' });
  const [destino, setDestino] = useState<Lado>({ conexao: aba.conexao ?? 0, banco: aba.banco ?? '' });
  const [opts, setOpts] = useState<CompareOptions>(newCompareOptions);
  const [ins, setIns] = useState(true);
  const [upd, setUpd] = useState(true);
  const [del, setDel] = useState(false); // desligado por padrão: o usuário decide apagar no destino

  const [ocupado, setOcupado] = useState(false);
  const [status, setStatus] = useState('');
  const [res, setRes] = useState<Resultado | null>(null);
  /** Itens marcados na lista: entram no script */
  const [marcados, setMarcados] = useState<boolean[]>([]);
  /** Item escolhido na lista: as diferenças dele aparecem embaixo */
  const [sel, setSel] = useState(0);
  const [abaInf, setAbaInf] = useState(dados ? '0' : 'dif');
  const [script, setScript] = useState('');
  /** Muda quando o script é montado de novo: refaz o editor (digitar nele não muda) */
  const [versaoScript, setVersaoScript] = useState(0);
  /** Registros da tabela e da situação escolhidas já buscados nos dois bancos */
  const [recs, setRecs] = useState<RecView[]>([]);

  const [dlgOpcoes, setDlgOpcoes] = useState(false);
  const [mapa, setMapa] = useState<{ tabelas: MapTable[]; db1: string; db2: string } | null>(null);
  const [lendoMapa, setLendoMapa] = useState(false);
  const [sinc, setSinc] = useState(false);

  const ctl = useRef<AbortController | null>(null);
  const comparacoes = useRef(0);
  const montagem = useRef(0);
  const serie = useRef(0);
  const lendo = useRef(false);
  const gradeLista = useRef<GradeApi>(null);
  const [alturaLista, arrastarLista] = useTamanho(260, 80);
  const [larguraDdl, arrastarDdl] = useTamanho(550, 150);

  const picked = (): { a1: Alvo; d1: string; a2: Alvo; d2: string } | null => {
    if (!origem.conexao || !destino.conexao || origem.banco === '' || destino.banco === '') avisar.alerta('Escolha a conexão e o banco da origem e do destino.');
    else if (origem.conexao === destino.conexao && origem.banco === destino.banco) avisar.alerta('Origem e destino são o mesmo banco.');
    else return { a1: { conexao: origem.conexao }, d1: origem.banco, a2: { conexao: destino.conexao }, d2: destino.banco };
    return null;
  };

  const cancelar = () => {
    if (!ocupado) return;
    ctl.current?.abort(); // a comparação vê na próxima consulta; o runScript, no próximo lote
    setStatus('Cancelando...');
  };

  const comparar = async () => {
    if (ocupado) return;
    const p = picked();
    if (!p) return;
    const { a1, d1, a2, d2 } = p;
    const o = opts; // as opções podem mudar na tela durante a comparação: esta usa as de agora
    const c = new AbortController();
    ctl.current = c;
    const op: Andamento = { progresso: (t) => !c.signal.aborted && setStatus('Comparando... ' + t), sinal: c.signal };
    setOcupado(true);
    setStatus('Comparando...');
    try {
      let objs: SchemaObj[] = [];
      let diffs: TableDiff[] = [];
      let header = '';
      if (dados) {
        // Dados só se compara com a mesma estrutura nos dois lados.
        const sd = await structDiff(a1, d1, a2, d2, o);
        if (sd !== '') {
          const msg = `As bases são diferentes, por isso a comparação de dados nem foi iniciada:\n\n${sd}\n\nIguale a estrutura antes em Comparação > Comparar esquemas.`;
          setStatus('');
          app.log(msg); // o aviso some sozinho: a lista das diferenças fica na Saída
          avisar.alerta(msg);
          return;
        }
        diffs = await compareData(a1, d1, a2, d2, o, undefined, op);
        header = await dataScriptHeader(a1, d1, a2, d2);
      } else objs = await compareSchemas(a1, d1, a2, d2, op);

      // O Fill do Pascal. DROP de objeto que só existe no destino vem desmarcado: o usuário decide.
      const m = dados ? diffs.map((d) => d.insCount + d.updCount + d.delCount > 0) : objs.map((x) => x.status === OnlySrc || x.status === DiffSt);
      const differ = dados ? m.filter(Boolean).length : objs.filter((x) => x.status !== Same).length;
      setRes({ n: ++comparacoes.current, a1: comBanco(a1, d1), db1: d1, a2: comBanco(a2, d2), db2: d2, objs, diffs, header, opts: o });
      setMarcados(m);
      setSel(0); // mostra as diferenças do primeiro
      setStatus(`${m.length} objeto(s), ${differ} com diferença`);
    } catch (e) {
      setStatus('');
      if (!c.signal.aborted) avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  // F9 = Comparar; com a comparação (ou o script) em andamento a aba não fecha
  useControleAba(aba.id, { executar: () => void comparar(), rodando: () => ocupado, parar: cancelar });

  // Resultado novo: o foco vai para o primeiro item da lista (se não houver um diálogo aberto por cima)
  useEffect(() => {
    if (res && marcados.length > 0 && !dlgOpcoes && !mapa) gradeLista.current?.focar(0, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res]);

  const diffsMarcados = useMemo(() => (res ? res.diffs.filter((_, i) => marcados[i]) : []), [res, marcados]);

  // O BuildScript do Pascal: refeito quando muda o resultado, o que está marcado ou Inserir/Atualizar/Excluir.
  useEffect(() => {
    if (!res) return;
    const vez = ++montagem.current;
    const mostrar = (s: string) => {
      if (vez !== montagem.current) return; // outra montagem começou depois desta
      setScript(s);
      setVersaoScript((v) => v + 1);
    };
    if (!dados) {
      mostrar(schemaScript(res.objs.filter((_, i) => marcados[i])));
      return;
    }
    // Dados: só o começo do script na tela, com as opções padrão e sem os triggers (o assistente de sincronização
    // monta o script inteiro com as opções escolhidas).
    const o = newSyncOptions(ins, upd, del);
    const partes: string[] = [];
    writeDataScript(
      {
        escrever: (t) => {
          partes.push(t);
        },
      },
      res.header,
      res.db2,
      diffsMarcados,
      o,
      PREVIEW_BYTES,
    ).then((completo) => {
      let s = partes.join('');
      if (!completo) {
        s = s.slice(0, s.lastIndexOf('\n') + 1); // sem a linha cortada no meio
        const n = diffsMarcados.reduce((t, d) => t + changes(o, d), 0);
        s += `\n-- (...)\n-- Prévia: só o começo do script aparece aqui. O script inteiro sincroniza ${milhar(n)} linha(s); Sincronizar usa ele todo.\n`;
      }
      mostrar(s);
    }, avisar.erro);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, diffsMarcados, marcados, ins, upd, del]);

  // ----------------------------------------------------------
  // Resultado por registro (dados): abas da situação e grade lado a lado
  // ----------------------------------------------------------
  /** Tabela escolhida na lista (o FRecDiff) */
  const d = dados && res ? res.diffs[sel] : undefined;
  /** Chaves dos registros da aba atual; os valores vêm dos dois bancos só quando aparecem na tela */
  const chaves = useMemo(() => (d && d.cols.length > 0 && abaInf !== 'script' ? rowLines(d, REC_STATES[Number(abaInf)], MAX_RECS) : []), [d, abaInf]);

  // Página seguinte dos registros. Erro de leitura aparece uma vez e a página fica sem valores (senão a grade
  // tentaria de novo a cada rolagem).
  // ponytail: as páginas vêm em sequência e ficam todas na memória (o desktop lia qualquer página e descartava o
  // cache com 50); para ir direto ao fim de uma aba enorme seria preciso uma grade com fonte de dados sob demanda.
  const maisRegistros = async (de: number) => {
    if (!res || !d || lendo.current || de >= chaves.length) return;
    const s = serie.current;
    lendo.current = true;
    let pagina: RecView[];
    try {
      pagina = await loadRecords(res.a1, res.db1, res.a2, res.db2, d, res.opts, chaves, de, PAGE_SIZE);
    } catch (e) {
      pagina = chaves.slice(de, de + PAGE_SIZE).map((l) => ({ state: l[0], src: null, tgt: null, diff: [] }));
      if (s === serie.current) avisar.erro('Erro ao ler os registros: ' + mensagemDe(e));
    }
    if (s !== serie.current) return; // a tabela ou a aba mudou enquanto lia
    lendo.current = false;
    setRecs((r) => (r.length === de ? [...r, ...pagina] : r));
  };

  // Outra tabela, outra situação ou outro resultado: começa da primeira página
  useEffect(() => {
    serie.current++;
    lendo.current = false;
    setRecs([]);
    void maisRegistros(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaves]);

  // Cada coluna da tabela vira um par origem | destino (colunas 2J+1 e 2J+2 da grade; a 0 é a situação).
  const colunasRec = useMemo<ColunaGrade[]>(() => {
    const r: ColunaGrade[] = [{ titulo: 'Situação', largura: 110 }];
    d?.cols.forEach((c, j) => {
      let cap = c;
      if (d.keyCols.some((k) => mesmoTexto(k, c))) cap += ' (chave)';
      else if (!d.compared[j]) cap += ' (ignorada)';
      else if (d.colDiffs[j] > 0) cap += ` (${milhar(d.colDiffs[j])} dif.)`;
      // 150: cabe data e hora
      r.push({ titulo: cap, subtitulo: 'Origem', largura: 150 }, { titulo: cap, subtitulo: 'Destino', largura: 150 });
    });
    return r;
  }, [d]);

  // ponytail: o loadRecords devolve os valores já como texto, sem o tipo: a grade não alinha número à direita nem
  // data no centro (no desktop também era tudo texto).
  const linhasRec = useMemo<Valor[][]>(
    () =>
      recs.map((r) => {
        const l: Valor[] = [r.state === RecSrc ? OnlySrc : r.state === RecTgt ? OnlyTgt : r.state === RecDiff ? DiffSt : Same];
        // o lado não tem o registro: célula vazia, não "(null)"
        for (let j = 0; j < (d?.cols.length ?? 0); j++) l.push(r.src ? (r.src[j] ?? null) : '', r.tgt ? (r.tgt[j] ?? null) : '');
        return l;
      }),
    [recs, d],
  );

  /** Diferente em vermelho claro; lado sem o registro em cinza (o nulo em itálico é da própria grade). */
  const classeRec = (l: number, c: number) => {
    const r = recs[l];
    if (!r || c === 0) return undefined;
    if (r.diff[(c - 1) >> 1]) return 'bg-rose-100 dark:bg-rose-950/60';
    return (c % 2 === 1 ? r.src : r.tgt) === null ? 'bg-fundo3' : undefined;
  };

  // ----------------------------------------------------------
  // Ações da barra
  // ----------------------------------------------------------
  const mapeamento = async () => {
    const p = picked();
    if (!p || lendoMapa) return;
    setLendoMapa(true);
    try {
      const tabelas = await mapTables(p.a1, p.d1, p.a2, p.d2);
      if (tabelas.length === 0) avisar.alerta('A origem e o destino não têm tabela em comum.');
      else setMapa({ tabelas, db1: p.d1, db2: p.d2 });
    } catch (e) {
      avisar.erro(e);
    } finally {
      setLendoMapa(false);
    }
  };

  // Esquema: o script é pequeno (DDL) e roda daqui mesmo. Dados vão pelo assistente (sincronizar).
  const executarNoDestino = async () => {
    if (ocupado) return;
    if (script.trim() === '' || !res) {
      avisar.alerta('Nada para executar.');
      return;
    }
    const ok = await confirmar({
      titulo: 'Executar no destino?',
      mensagem: `Executar o script no banco de destino "${res.db2}"?\nEssa operação altera o destino.`,
      confirmar: 'Executar',
      tom: 'normal',
    });
    if (!ok) return;
    const c = new AbortController();
    ctl.current = c;
    setOcupado(true);
    setStatus('Executando no destino...');
    try {
      await runScript(res.a2, script, {
        progresso: (lidos, total) => !c.signal.aborted && setStatus(`Executando no destino: ${Math.min(100, Math.floor((lidos * 100) / Math.max(total, 1)))}%`),
        sinal: c.signal,
      });
      setStatus('Script executado. Compare de novo para conferir.');
    } catch (e) {
      if (c.signal.aborted) setStatus('Execução cancelada: o que já rodou continua no destino. Compare de novo para conferir.');
      else {
        setStatus('Erro na execução');
        avisar.erro(e);
      }
    } finally {
      setOcupado(false);
    }
  };

  const salvarScript = async () => {
    if (script.trim() === '' || !res) return;
    try {
      const g = await criarArquivo(`sincronizar_${res.db2}.sql`, ARQ_SQL);
      if (!g) return;
      try {
        await g.escrever(script); // UTF-8 sem BOM: o cliente mysql não aceita BOM
        await g.fechar();
      } catch (e) {
        await g.cancelar().catch(() => {});
        throw e;
      }
      setStatus('Script salvo em ' + g.nome);
    } catch (e) {
      avisar.erro(e);
    }
  };

  const sincronizar = () => {
    const o = newSyncOptions(ins, upd, del);
    if (!res || diffsMarcados.reduce((t, x) => t + changes(o, x), 0) === 0) avisar.alerta('Nada para sincronizar.');
    else setSinc(true);
  };

  // ----------------------------------------------------------
  // Tela
  // ----------------------------------------------------------
  const linhasLista = useMemo<Valor[][]>(() => {
    if (!res) return [];
    const m = (i: number) => (marcados[i] ? '1' : '');
    return dados
      ? res.diffs.map((x, i) => [m(i), x.table, milhar(x.insCount), milhar(x.delCount), milhar(x.updCount), milhar(x.equal), x.note])
      : res.objs.map((x, i) => [m(i), x.objType, x.name, x.status]);
  }, [res, marcados, dados]);

  // Quantidades da tabela escolhida nas abas da situação
  const qtd = d ? [d.insCount + d.updCount + d.delCount + d.equal, d.insCount, d.updCount, d.delCount, d.equal] : null;
  const abasInf: ItemAba[] = dados
    ? [...REC_TABS.map((t, i) => ({ id: String(i), titulo: qtd ? `${t} (${milhar(qtd[i])})` : t })), { id: 'script', titulo: 'Script de sincronização' }]
    : [
        { id: 'dif', titulo: 'Diferenças (origem | destino)' },
        { id: 'script', titulo: 'Script de sincronização' },
      ];
  const obj = !dados && res ? res.objs[sel] : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-2 bg-fundo2 border-b border-borda">
        <h3 className="text-sm font-bold">{dados ? 'Comparar dados' : 'Comparar esquemas'}</h3>
        <div className="mt-0.5 text-xs text-texto2">Escolha a origem (modelo) e o destino (que será alterado) e clique em Comparar.</div>
      </div>

      <div className="shrink-0 flex items-center gap-1 px-1 py-1 bg-fundo2 border-b border-borda">
        <Botao tom="primario" onClick={() => void comparar()} ocupado={ocupado} title="F9">
          Comparar
        </Botao>
        {ocupado && <Botao onClick={cancelar}>Cancelar</Botao>}
        {dados ? (
          <>
            <Botao onClick={() => setDlgOpcoes(true)}>Opções...</Botao>
            <Botao onClick={() => void mapeamento()} ocupado={lendoMapa}>
              Mapeamento...
            </Botao>
            {/* assistente: saída, opções e execução com andamento */}
            <Botao onClick={sincronizar} disabled={ocupado}>
              Sincronizar...
            </Botao>
            <span className="flex items-center gap-3.5 pl-3.5">
              <Toggle size="sm" checked={ins} onChange={setIns} label="Inserir" />
              <Toggle size="sm" checked={upd} onChange={setUpd} label="Atualizar" />
              <Toggle size="sm" checked={del} onChange={setDel} label="Excluir" />
            </span>
          </>
        ) : (
          <>
            <Botao onClick={() => void executarNoDestino()} disabled={ocupado}>
              Executar no destino
            </Botao>
            <Botao onClick={() => void salvarScript()}>Salvar script</Botao>
          </>
        )}
        <span className="pl-3 min-w-0 truncate text-xs text-texto2">{status}</span>
      </div>

      {/* Risco mais grosso entre a origem e o destino */}
      <div className="shrink-0 border-b-2 border-borda">
        <SeletorConexao lado="origem" valor={origem} onMudar={setOrigem} />
      </div>
      <div className="shrink-0">
        <SeletorConexao lado="destino" valor={destino} onMudar={setDestino} />
      </div>

      <div style={{ height: alturaLista }} className="shrink-0 min-h-0 flex flex-col">
        <Grade
          ref={gradeLista}
          colunas={dados ? COLUNAS_DADOS : COLUNAS_ESQUEMA}
          linhas={linhasLista}
          editavel
          onAlterar={(l, _c, v) => setMarcados((m) => m.map((x, i) => (i === l ? v === '1' : x)))}
          onFoco={(l) => setSel(l)}
          rodape={(_p, n) => `${milhar(n)} ${dados ? 'tabela(s)' : 'objeto(s)'}`}
          vazio="Clique em Comparar"
        />
      </div>
      <Divisor aoArrastar={arrastarLista} />

      <Abas abas={abasInf} ativa={abaInf} onTrocar={setAbaInf} />
      {abaInf === 'script' ? (
        // Nos dados é só a prévia: o script executado sai do resultado da comparação
        <EditorSql key={versaoScript} inicial={script} somenteLeitura={dados} onMudar={dados ? undefined : setScript} className="flex-1" />
      ) : dados ? (
        // Uma grade por tabela, situação e resultado: a rolagem e o pedido de mais páginas recomeçam
        <Grade
          key={`${res?.n}:${sel}:${abaInf}`}
          colunas={colunasRec}
          linhas={linhasRec}
          classeCelula={classeRec}
          onFimDaRolagem={() => void maisRegistros(recs.length)}
          rodape={(pos) => `Registro ${milhar(pos)} de ${milhar(chaves.length)}`}
          rodapeExtra={chaves.length >= MAX_RECS ? `A grade mostra só os primeiros ${milhar(MAX_RECS)} registros desta aba.` : undefined}
          vazio={d && d.cols.length === 0 ? d.note : chaves.length > 0 ? 'Lendo os registros...' : 'Nenhum registro'}
        />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <CaixaDdl texto={obj?.srcDdl ?? ''} outro={obj?.tgtDdl ?? ''} temOutro={obj?.hasTgt ?? false} largura={larguraDdl} />
          <Divisor vertical aoArrastar={arrastarDdl} />
          <CaixaDdl texto={obj?.tgtDdl ?? ''} outro={obj?.srcDdl ?? ''} temOutro={obj?.hasSrc ?? false} />
        </div>
      )}

      {dlgOpcoes && (
        <DialogoOpcoes
          opcoes={opts}
          onFechar={() => setDlgOpcoes(false)}
          onOk={(o) => {
            setOpts(o);
            setDlgOpcoes(false);
            setStatus('Opções alteradas: valem na próxima comparação.');
          }}
        />
      )}
      {mapa && (
        <DialogoMapeamento
          tabelas={mapa.tabelas}
          opcoes={opts}
          db1={mapa.db1}
          db2={mapa.db2}
          onFechar={() => setMapa(null)}
          onOk={(maps) => {
            setOpts((o) => ({ ...o, maps }));
            setMapa(null);
            setStatus('Mapeamento alterado: vale na próxima comparação.');
          }}
        />
      )}
      {sinc && res && (
        <Sincronizar
          alvo={res.a2}
          db={res.db2}
          header={res.header}
          diffs={diffsMarcados}
          ins={ins}
          upd={upd}
          del={del}
          onFechar={(resultado, recomparar) => {
            setSinc(false);
            if (resultado !== '') setStatus(resultado);
            if (recomparar) void comparar();
          }}
        />
      )}
    </div>
  );
};
