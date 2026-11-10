/**
 * Documento de tabela (o TTableTab do desktop, uTableEdit.pas), como o do dbForge: abas Dados, Colunas, Foreign Keys,
 * Índices, Opções, Triggers e SQL, com Atualizar objeto / Aplicar alterações / Script das alterações no rodapé.
 * A estrutura carregada e a editada viram CREATE TABLE (specDdl) e o ALTER sai da mesma lógica da comparação.
 *
 * Os nomes vão sem o banco na frente, como no desktop: o Alvo da aba leva o banco (o WithDb do Pascal) e o
 * servidor faz o USE antes de rodar.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Columns3, FileCode, KeyRound, ListOrdered, Pencil, Plus, RefreshCw, SlidersHorizontal, Table, Trash2, Zap } from 'lucide-react';
import { Alvo, Valor, escalar, linhas, rodar, texto } from '../lib/api';
import { getCreate, q, versaoCurta } from '../lib/db';
import { TableSpec, designScript, escapeStr, hasDecimals, joinType, newColSpec, specDdl, splitType } from '../lib/compareLogic';
import { splitScript } from '../lib/sqlText';
import { avisar, confirmar, confirmarDescarte } from '../lib/avisos';
import { Aba, useApp, useControleAba } from '../app/contexto';
import { Abas, Botao, CAMPO, Carregando, Dialogo, Divisor, ItemAba, ItemMenu, MenuContexto, useTamanho } from './ui';
import { ColunaGrade, Grade, GradeApi, dataBr } from './Grade';
import { GradeDados, GradeDadosApi } from './GradeDados';
import { EditorSql, EditorSqlApi } from './EditorSql';
import { mensagemDe } from './AbaRotina';

// Colunas da grade de colunas; 9 e 10 ficam escondidas (nome ao carregar e o extra, ex. ON UPDATE).
const cName = 0, cType = 1, cSize = 2, cDec = 3, cNotNull = 4, cPk = 5, cAuto = 6, cDefault = 7, cComment = 8, cOrig = 9, cExtra = 10;
const ColTypes = [
  'tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'bit', 'char', 'varchar', 'tinytext', 'text',
  'mediumtext', 'longtext', 'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'date', 'datetime', 'timestamp',
  'time', 'year', 'enum', 'set', 'json', 'int unsigned', 'bigint unsigned',
];
const FkRules = ['', 'CASCADE', 'SET NULL']; // vazio = RESTRICT, o padrão
// Grade de restrições.
const rName = 0, rCols = 1, rKind = 2, rRefTable = 3, rRefCols = 4, rOnDelete = 5, rOnUpdate = 6;
const sPk = 'Chave primária', sFk = 'Chave estrangeira';
// Grade de triggers; 3 a 5 ficam escondidas: 3 = comando, 4 = nome no banco ('' = nova), 5 = '1' se mudou na tela.
const tName = 0, tTiming = 1, tEvent = 2, tBody = 3, tOrig = 4, tChanged = 5;

const SqlColumns =
  'SELECT column_name, column_type, is_nullable, extra, column_default, column_default IS NULL, ' +
  'column_comment, data_type FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position';
const SqlIndexes =
  'SELECT index_name, MIN(non_unique), MIN(index_type), GROUP_CONCAT(CONCAT(column_name, ' +
  "IFNULL(CONCAT('(', sub_part, ')'), '')) ORDER BY seq_in_index SEPARATOR ', ') FROM information_schema.statistics " +
  'WHERE table_schema=? AND table_name=? GROUP BY index_name ORDER BY index_name';
const SqlFks =
  "SELECT k.constraint_name, GROUP_CONCAT(k.column_name ORDER BY k.ordinal_position SEPARATOR ', '), " +
  "MIN(k.referenced_table_name), GROUP_CONCAT(k.referenced_column_name ORDER BY k.ordinal_position SEPARATOR ', '), " +
  'MIN(r.delete_rule), MIN(r.update_rule) FROM information_schema.key_column_usage k ' +
  'JOIN information_schema.referential_constraints r ON r.constraint_schema = k.table_schema ' +
  'AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name ' +
  'WHERE k.table_schema=? AND k.table_name=? AND k.referenced_table_name IS NOT NULL GROUP BY k.constraint_name ORDER BY 1';
const SqlOptions =
  'SELECT table_collation, auto_increment, row_format, avg_row_length, create_options, table_rows, ' +
  'data_length, index_length, create_time, update_time FROM information_schema.tables WHERE table_schema=? AND table_name=?';
const OptionNames = [
  'Charset', 'Collation', 'Auto increment', 'Formato da linha', 'Tamanho médio da linha', 'Opções de criação', 'Linhas (estimado)',
  'Tamanho dos dados', 'Tamanho dos índices', 'Criada em', 'Atualizada em',
];
const SqlTriggers =
  'SELECT trigger_name, action_timing, event_manipulation, action_statement FROM information_schema.triggers ' +
  'WHERE event_object_schema=? AND event_object_table=? ORDER BY action_timing, event_manipulation, action_order';

const MOMENTOS = ['BEFORE', 'AFTER'];
const EVENTOS = ['INSERT', 'UPDATE', 'DELETE'];

/** O que está na tela: os campos e as linhas das grades (tudo texto, como as grades do desktop). */
export interface Estado {
  nome: string;
  engine: string;
  comentario: string;
  cols: string[][];
  cons: string[][];
  idx: string[][];
  trg: string[][];
  /** Triggers excluídas na tela (vão como DROP no Aplicar) */
  trgDrop: string[];
}

const VAZIO: Estado = { nome: '', engine: 'InnoDB', comentario: '', cols: [], cons: [], idx: [], trg: [], trgDrop: [] };

type Lista = 'cols' | 'cons' | 'idx';

const mesmoTexto = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const flag = (b: boolean) => (b ? '1' : '');
/** O AdjustLineBreaks do Pascal, para LF (o editor e os scripts daqui usam só LF). */
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

// column_default vira a expressão que vai no DDL: texto entre aspas, números e CURRENT_TIMESTAMP como estão.
// No MariaDB o texto já vem entre aspas e o NULL vem escrito.
export function defaultExpr(v: string, isNull: boolean, dataType: string, extra: string): string {
  if (isNull || mesmoTexto(v, 'NULL')) return '';
  if (
    /DEFAULT_GENERATED/i.test(extra) ||
    v.startsWith("'") ||
    /^current_timestamp/i.test(v) ||
    /^b'/i.test(v) ||
    ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'decimal', 'float', 'double', 'year'].includes(dataType.toLowerCase())
  )
    return v;
  return "'" + escapeStr(v) + "'";
}

/** Estrutura da tabela no banco (o FOld do Pascal). */
async function readSpec(alvo: Alvo, db: string, tabela: string): Promise<TableSpec> {
  const old: TableSpec = { name: tabela, engine: 'InnoDB', comment: '', cols: [], idx: [], fks: [] };
  const p = [db, tabela];
  const [tab, colunas, indices, fks] = await Promise.all([
    linhas(alvo, 'SELECT engine, table_comment FROM information_schema.tables WHERE table_schema=? AND table_name=?', p),
    linhas(alvo, SqlColumns, p),
    linhas(alvo, SqlIndexes, p),
    linhas(alvo, SqlFks, p),
  ]);
  for (const r of tab) {
    old.engine = r[0];
    old.comment = r[1];
  }
  // ponytail: colunas geradas (VIRTUAL/STORED) não são tratadas; alterá-las aqui perde a expressão
  for (const r of colunas)
    old.cols.push(
      newColSpec({
        name: r[0],
        orig: r[0],
        colType: r[1],
        notNull: r[2] === 'NO',
        autoInc: /auto_increment/i.test(r[3]),
        extra: r[3].replace(/auto_increment|DEFAULT_GENERATED/gi, '').trim(),
        default: defaultExpr(r[4], r[5] === '1', r[7], r[3]),
        comment: r[6],
      }),
    );
  for (const r of indices)
    if (r[0] === 'PRIMARY') {
      // ponytail: a PK sai na ordem das colunas da tabela; PK composta em outra ordem vira diferença
      for (const s of r[3].split(',')) for (const c of old.cols) if (mesmoTexto(c.name, s.trim())) c.pk = true;
    } else old.idx.push({ name: r[0], cols: r[3], kind: ['FULLTEXT', 'SPATIAL'].includes(r[2].toUpperCase()) ? r[2].toUpperCase() : r[1] === '0' ? 'UNIQUE' : 'INDEX' });
  const regra = (r: string) => (['RESTRICT', 'NO ACTION'].includes(r.toUpperCase()) ? '' : r);
  for (const r of fks) old.fks.push({ name: r[0], cols: r[1], refTable: r[2], refCols: r[3], onDelete: regra(r[4]), onUpdate: regra(r[5]) });
  return old;
}

/** Abas só de leitura: as opções da tabela e as triggers como estão no banco. */
async function loadInfo(alvo: Alvo, db: string, tabela: string): Promise<{ opt: string[][]; trg: string[][] }> {
  const [r, t] = await Promise.all([linhas(alvo, SqlOptions, [db, tabela]), linhas(alvo, SqlTriggers, [db, tabela])]);
  const opt = OptionNames.map((n) => [n, '']);
  if (r.length > 0) {
    opt[0][1] = r[0][0].slice(0, Math.max(0, r[0][0].indexOf('_'))); // o charset é o começo da collation
    for (let k = 0; k <= 9; k++) opt[k + 1][1] = k >= 8 ? dataBr(r[0][k]) : r[0][k];
  }
  return { opt, trg: t.map((x) => [...x, x[0], '']) };
}

/** Refaz a linha PRIMARY das restrições (sempre a primeira) a partir das colunas marcadas como PK. */
export function syncPk(cols: string[][], cons: string[][]): string[][] {
  const s = cols
    .filter((c) => c[cName].trim() !== '' && c[cPk] === '1')
    .map((c) => c[cName].trim())
    .join(', ');
  const resto = cons[0]?.[rKind] === sPk ? cons.slice(1) : cons;
  return s === '' ? resto : [['PRIMARY', s, sPk, '', '', '', ''], ...resto];
}

/** A estrutura carregada nas grades (o Fill do Pascal). */
export function preencher(old: TableSpec): Pick<Estado, 'nome' | 'engine' | 'comentario' | 'cols' | 'cons' | 'idx'> {
  const cols = old.cols.map((c) => {
    const t = splitType(c.colType);
    return [c.name, t.base, t.size, t.dec, flag(c.notNull), flag(c.pk), flag(c.autoInc), c.default, c.comment, c.orig, c.extra];
  });
  return {
    nome: old.name,
    engine: old.engine,
    comentario: old.comment,
    cols,
    cons: syncPk(cols, old.fks.map((f) => [f.name, f.cols, sFk, f.refTable, f.refCols, f.onDelete, f.onUpdate])),
    idx: old.idx.map((i) => [i.name, i.cols, i.kind]),
  };
}

/** A estrutura como está na tela (o Spec do Pascal). Linhas sem nome são ignoradas. */
export function specDe(e: Estado): TableSpec {
  return {
    name: e.nome.trim(),
    engine: e.engine.trim(),
    comment: e.comentario,
    cols: e.cols
      .filter((c) => c[cName].trim() !== '')
      .map((c) =>
        newColSpec({
          name: c[cName].trim(),
          colType: joinType(c[cType], c[cSize], c[cDec]),
          notNull: c[cNotNull] === '1',
          pk: c[cPk] === '1',
          autoInc: c[cAuto] === '1',
          default: c[cDefault].trim(),
          comment: c[cComment],
          orig: c[cOrig],
          extra: c[cExtra],
        }),
      ),
    idx: e.idx.filter((i) => i[0].trim() !== '').map((i) => ({ name: i[0].trim(), cols: i[1], kind: i[2].trim().toUpperCase() })),
    // A linha da chave primária nas restrições sai das colunas marcadas como PK: não entra aqui.
    fks: e.cons
      .filter((r) => r[rName].trim() !== '' && r[rKind] !== sPk)
      .map((r) => ({ name: r[rName].trim(), cols: r[rCols], refTable: r[rRefTable].trim(), refCols: r[rRefCols], onDelete: r[rOnDelete].trim(), onUpdate: r[rOnUpdate].trim() })),
  };
}

/** DROP das excluídas e das alteradas (o MySQL não tem ALTER TRIGGER) e CREATE das novas e alteradas. */
export function trgScript(e: Estado, tabela: string): string {
  let r = '';
  for (const n of e.trgDrop) r += 'DROP TRIGGER IF EXISTS ' + q(n) + ';\n';
  for (const t of e.trg)
    if (t[tChanged] === '1') {
      if (t[tOrig] !== '') r += 'DROP TRIGGER IF EXISTS ' + q(t[tOrig]) + ';\n';
      r += 'DELIMITER $$\nCREATE TRIGGER ' + q(t[tName]) + ' ' + t[tTiming] + ' ' + t[tEvent] + ' ON ' + q(tabela) + ' FOR EACH ROW\n' + lf(t[tBody]) + '$$\nDELIMITER ;\n';
    }
  return r;
}

/** Alterações da estrutura ainda não aplicadas (o HasChanges do Pascal). */
function mudou(old: TableSpec, e: Estado): boolean {
  const s = specDe(e);
  return old.name === '' ? s.cols.length > 0 : designScript(old, s, false) !== '' || trgScript(e, s.name) !== '';
}

const comTamanho = ['varchar', 'char', 'varbinary', 'binary'];

/**
 * Chave primária nunca é nula: marcar PK marca Não nulo. Ao trocar o tipo, decimais só ficam nos tipos que os
 * aceitam e varchar/decimal sem tamanho ganham o padrão (255; 15,2). linha já está com o valor novo na coluna c.
 */
function colsChanged(linha: string[], c: number) {
  if (c === cPk && linha[cPk] === '1') linha[cNotNull] = '1';
  if (c !== cType) return;
  const t = linha[cType].toLowerCase();
  if (!hasDecimals(t)) linha[cDec] = '';
  if (linha[cSize] !== '') return;
  if (comTamanho.includes(t)) linha[cSize] = '255';
  else if (t === 'decimal' || t === 'numeric') {
    linha[cSize] = '15';
    linha[cDec] = '2';
  }
}

/** Índice sem nome ganha idx_<colunas> ao escolher as colunas (compostas: idx_a_b). */
function idxChanged(linha: string[], c: number) {
  if (c !== 1 || linha[0].trim() !== '') return;
  const s = linha[1].replace(/\(\d+\)|\s/g, '');
  if (s !== '') linha[0] = 'idx_' + s.replaceAll(',', '_');
}

// ==========================================================
// Diálogo da trigger
// ==========================================================
interface Trigger {
  nome: string;
  momento: string;
  evento: string;
  corpo: string;
}

/** Nome, momento, evento e corpo da trigger. Nome em branco vira trg_<tabela>_<momento>_<evento>. */
const DialogoTrigger: React.FC<{ titulo: string; tabela: string; inicial: Trigger; onOk: (t: Trigger) => void; onFechar: () => void }> = ({
  titulo,
  tabela,
  inicial,
  onOk,
  onFechar,
}) => {
  const [nome, setNome] = useState(inicial.nome);
  const [momento, setMomento] = useState(MOMENTOS.includes(inicial.momento) ? inicial.momento : MOMENTOS[0]);
  const [evento, setEvento] = useState(EVENTOS.includes(inicial.evento) ? inicial.evento : EVENTOS[0]);
  const campoNome = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorSqlApi>(null);

  useEffect(() => {
    if (inicial.nome === '') campoNome.current?.focus(); // inclusão: o nome é o primeiro campo vazio
    else editor.current?.focar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ok = () => {
    const corpo = (editor.current?.texto() ?? '').trimEnd();
    if (corpo === '') return avisar.alerta('Informe o corpo da trigger.');
    onOk({ nome: nome.trim() || `trg_${tabela}_${momento}_${evento}`.toLowerCase(), momento, evento, corpo });
  };

  return (
    <Dialogo
      titulo={titulo}
      subtitulo={`Tabela ${tabela}. Use NEW.coluna / OLD.coluna no corpo. Vai para o banco no Aplicar alterações.`}
      largura={780}
      altura={560}
      onFechar={onFechar}
      onEnviar={ok}
      focar={false}
      rodape={
        <>
          <Botao tom="primario" onClick={ok}>
            OK
          </Botao>
          <Botao onClick={onFechar}>Cancelar</Botao>
        </>
      }
    >
      <div className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-borda text-xs text-texto2">
        <label className="flex items-center gap-2">
          Nome:
          <input ref={campoNome} value={nome} onChange={(e) => setNome(e.target.value)} maxLength={64} className={`${CAMPO} w-60`} />
        </label>
        <label className="flex items-center gap-2">
          Momento:
          <select value={momento} onChange={(e) => setMomento(e.target.value)} className={`${CAMPO} w-32`}>
            {MOMENTOS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Evento:
          <select value={evento} onChange={(e) => setEvento(e.target.value)} className={`${CAMPO} w-32`}>
            {EVENTOS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>
      {/* O Esc do editor fecha o autocompletar e a busca dele: não chega ao diálogo, que fecharia perdendo o corpo digitado */}
      <div className="flex-1 min-h-0 flex flex-col" onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}>
        <EditorSql ref={editor} inicial={inicial.corpo} className="flex-1" />
      </div>
    </Dialogo>
  );
};

// ==========================================================
// A aba
// ==========================================================
const COLS_OPCOES: ColunaGrade[] = [
  { titulo: 'Opção', largura: 200 },
  { titulo: 'Valor', largura: 400 },
];
const COLS_TRG: ColunaGrade[] = [
  { titulo: 'Nome', largura: 200 },
  { titulo: 'Momento', largura: 90 },
  { titulo: 'Evento', largura: 90 },
  { titulo: '', largura: -1 },
  { titulo: '', largura: -1 },
  { titulo: '', largura: -1 },
];
const BARRA = 'shrink-0 flex items-center gap-1 px-1 py-1 border-b border-borda';

export const AbaTabela: React.FC<{ aba: Extract<Aba, { tipo: 'tabela' }>; ativa: boolean }> = ({ aba, ativa }) => {
  const app = useApp();
  const banco = aba.banco;
  const alvo = useMemo<Alvo>(() => ({ conexao: aba.conexao, banco: aba.banco }), [aba.conexao, aba.banco]);

  const [estado, setEstado] = useState<Estado>(VAZIO);
  // Cópia sempre atual da tela: as ações leem daqui logo depois de confirmar a célula em edição da grade
  // (o PostEdit do desktop), sem esperar a tela redesenhar.
  const atual = useRef(estado);
  const mudar = (m: Partial<Estado>) => {
    atual.current = { ...atual.current, ...m };
    setEstado(atual.current);
  };
  /** A estrutura como está no banco (name = '': tabela nova); null: ainda não carregou */
  const [antigo, setAntigo] = useState<TableSpec | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [opcoes, setOpcoes] = useState<string[][]>([]);
  const [interna, setInterna] = useState(aba.dados && aba.tabela !== '' ? 'dados' : 'cols');
  // A aba Dados só é montada quando aberta pela primeira vez (tabela grande demora) e depois fica montada,
  // escondida, para não perder as alterações pendentes.
  const [abriuDados, setAbriuDados] = useState(interna === 'dados');
  const [sqlTexto, setSqlTexto] = useState('');
  const [versao, setVersao] = useState('');
  const [info, setInfo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  /** Tabelas do banco, para a lista da "Tabela referenciada": lidas uma vez, ao abrir as Foreign Keys (como no desktop) */
  const [tabelas, setTabelas] = useState<string[] | null>(null);
  // ponytail: colunas das tabelas referenciadas ficam guardadas até o Atualizar objeto (o desktop consulta a cada
  // edição); tabela alterada por fora nesse meio tempo aparece com as colunas antigas na lista.
  const [colsDe, setColsDe] = useState(new Map<string, string[]>());
  const [consLinha, setConsLinha] = useState(-1);
  const [trgLinha, setTrgLinha] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Diálogo da trigger aberto; linha = -1: trigger nova */
  const [dlg, setDlg] = useState<(Trigger & { linha: number }) | null>(null);
  const [alturaTrg, arrastarTrg] = useTamanho(260, 80, -1);

  const gradeCols = useRef<GradeApi>(null);
  const gradeCons = useRef<GradeApi>(null);
  const gradeIdx = useRef<GradeApi>(null);
  const gradeTrg = useRef<GradeApi>(null);
  const grades = { cols: gradeCols, cons: gradeCons, idx: gradeIdx, trg: gradeTrg };
  const dados = useRef<GradeDadosApi>(null);
  const campoNome = useRef<HTMLInputElement>(null);
  const idEngines = useId();
  const carga = useRef(0);
  const pedidoSql = useRef(0);

  /** Nome da tabela no banco ('' = tabela nova, sem as abas só de leitura nem Dados) */
  const tabela = antigo ? antigo.name : aba.tabela;
  const nova = tabela === '';

  /** Confirma a célula em edição das grades, para ler o valor digitado (o PostEdit do desktop). */
  const postEdit = () => {
    for (const g of [gradeCols, gradeCons, gradeIdx]) g.current?.confirmarEdicao();
  };

  /** Lê a estrutura do banco para a tela (nome = '': tabela nova). Devolve o que leu. */
  const carregar = async (nome: string): Promise<TableSpec> => {
    const vez = ++carga.current;
    let old: TableSpec = { name: '', engine: 'InnoDB', comment: '', cols: [], idx: [], fks: [] };
    let inf: { opt: string[][]; trg: string[][] } = { opt: [], trg: [] };
    if (nome !== '') {
      old = await readSpec(alvo, banco, nome);
      inf = await loadInfo(alvo, banco, nome);
    }
    if (vez !== carga.current) return old; // outra carga começou depois desta
    atual.current = { ...preencher(old), trg: inf.trg, trgDrop: [] };
    setEstado(atual.current);
    setOpcoes(inf.opt);
    setColsDe(new Map());
    setAntigo(old);
    setInfo(nome === '' ? 'Inclua as colunas e clique em Aplicar alterações.' : `${old.cols.length} coluna(s), ${old.idx.length} índice(s), ${old.fks.length} chave(s) estrangeira(s)`);
    return old;
  };

  const abrir = async () => {
    setFalhou(false);
    try {
      await carregar(aba.tabela);
    } catch (e) {
      avisar.erro(e);
      setFalhou(true);
    }
  };

  useEffect(() => {
    void abrir();
    // sem a versão a faixa só mostra servidor, usuário e banco
    escalar(alvo, 'SELECT VERSION()').then(
      (v) => setVersao(` (${versaoCurta(v)})`),
      () => {},
    );
    // Só ao abrir: depois quem recarrega é o Atualizar objeto e o Aplicar (a aba continua montada quando inativa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // O FocusFirst do desktop, na primeira vez que a aba aparece já carregada
  const focou = useRef(false);
  useEffect(() => {
    if (!ativa || !antigo || focou.current) return;
    focou.current = true;
    if (antigo.name === '') campoNome.current?.focus(); // inclusão: foco no primeiro campo a preencher
    else if (interna === 'cols') gradeCols.current?.focar(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativa, antigo]);

  // O ShowData do desktop: pedir os dados de uma tabela já aberta (abrirTabela com dados) traz a aba Dados para a frente
  useEffect(() => {
    if (!aba.dados || aba.tabela === '') return;
    setInterna('dados');
    setAbriuDados(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba.dados]);

  // Como no uMain: alterações da estrutura ou dos dados seguram a aba; Ctrl+S, F9 e Exportar CSV valem para a
  // aba Dados quando é ela que está aberta.
  const naDados = interna === 'dados';
  useControleAba(aba.id, {
    temAlteracoes: () => (antigo !== null && mudou(antigo, atual.current)) || Boolean(dados.current?.temAlteracoes()),
    executar: naDados ? () => void dados.current?.recarregar() : undefined,
    salvar: naDados ? () => void dados.current?.salvar() : undefined,
    exportarCsv: naDados ? () => dados.current?.exportarCsv() : undefined,
  });

  // ----------------------------------------------------------
  // Abas internas
  // ----------------------------------------------------------
  const mostrar = (id: string) => {
    postEdit();
    setInterna(id);
    if (id === 'dados') setAbriuDados(true);
    // aba.dados acompanha a aba interna: assim um novo pedido dos dados (abrirTabela) muda o valor e volta para a Dados
    if (aba.dados !== (id === 'dados')) app.alterarAba(aba.id, { dados: id === 'dados' });
  };

  /** Aba SQL: o CREATE do banco ou, com alterações pendentes, a estrutura como está na tela. */
  const mostrarSql = async (old: TableSpec) => {
    const vez = ++pedidoSql.current;
    let s: string;
    try {
      if (old.name === '' || mudou(old, atual.current)) s = '-- Estrutura com as alterações ainda não aplicadas\n' + specDdl(specDe(atual.current));
      else s = await getCreate(alvo, 'TABLE', banco, old.name);
    } catch (e) {
      s = '-- ' + mensagemDe(e);
    }
    if (vez === pedidoSql.current) setSqlTexto(s);
  };

  const trocarAba = (id: string) => {
    mostrar(id);
    if (id === 'cons') {
      mudar({ cons: syncPk(atual.current.cols, atual.current.cons) });
      if (tabelas === null)
        linhas(alvo, "SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE' ORDER BY 1", [banco]).then(
          (l) => setTabelas(l.map((r) => r[0])),
          avisar.erro,
        );
    } else if (id === 'sql' && antigo) void mostrarSql(antigo);
    // O foco vai para a grade da aba, na linha em que estava (a aba só aparece depois de a tela redesenhar)
    const g = id in grades ? grades[id as keyof typeof grades] : null;
    if (g) setTimeout(() => g.current?.focar(g.current.foco()?.linha ?? 0));
  };

  // ----------------------------------------------------------
  // Grades de colunas, restrições e índices
  // ----------------------------------------------------------
  // Nomes das colunas como estão na grade (inclusive as ainda não aplicadas).
  const colNames = useMemo(() => estado.cols.map((c) => c[cName].trim()).filter((n) => n !== ''), [estado.cols]);

  // Colunas da tabela referenciada pela chave estrangeira em foco, para a lista das "Colunas referenciadas"
  const refTabela = (estado.cons[consLinha]?.[rRefTable] ?? '').trim();
  const autoRelacao = mesmoTexto(refTabela, estado.nome.trim());
  useEffect(() => {
    if (refTabela === '' || autoRelacao || colsDe.has(refTabela)) return;
    linhas(alvo, 'SELECT column_name FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position', [banco, refTabela]).then(
      (l) => setColsDe((m) => new Map(m).set(refTabela, l.map((r) => r[0]))),
      avisar.erro,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refTabela, autoRelacao, colsDe]);
  // auto-relacionamento: as colunas da grade, mesmo as não aplicadas
  const refCols = autoRelacao ? colNames : colsDe.get(refTabela);

  const colunasCols = useMemo<ColunaGrade[]>(
    () => [
      { titulo: 'Nome', largura: 200 },
      { titulo: 'Tipo', largura: 130, editor: 'lista', itens: ColTypes },
      { titulo: 'Tamanho', largura: 70, alinhar: 'dir' },
      { titulo: 'Decimais', largura: 64, alinhar: 'dir' },
      { titulo: 'Não nulo', largura: 64, editor: 'check' },
      { titulo: 'PK', largura: 44, editor: 'check' },
      { titulo: 'Auto inc.', largura: 64, editor: 'check' },
      { titulo: 'Padrão', largura: 150 },
      { titulo: 'Comentário', largura: 300 },
      { titulo: '', largura: -1 },
      { titulo: '', largura: -1 },
    ],
    [],
  );
  // As listas de colunas e tabelas acompanham a estrutura do momento.
  const colunasCons = useMemo<ColunaGrade[]>(
    () => [
      { titulo: 'Nome', largura: 180 },
      { titulo: 'Colunas', largura: 180, editor: 'lista', itens: colNames },
      { titulo: 'Tipo', largura: 120, editor: 'nenhum' },
      { titulo: 'Tabela referenciada', largura: 160, editor: 'lista', itens: tabelas ?? [] },
      { titulo: 'Colunas referenciadas', largura: 160, editor: 'lista', itens: refCols ?? [] },
      { titulo: 'Ao excluir', largura: 100, editor: 'lista', itens: FkRules, fixo: true },
      { titulo: 'Ao atualizar', largura: 100, editor: 'lista', itens: FkRules, fixo: true },
    ],
    [colNames, tabelas, refCols],
  );
  const colunasIdx = useMemo<ColunaGrade[]>(
    () => [
      { titulo: 'Nome', largura: 200 },
      { titulo: 'Colunas', largura: 400, editor: 'lista', itens: colNames },
      { titulo: 'Tipo', largura: 100, editor: 'lista', itens: ['INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL'], fixo: true },
    ],
    [colNames],
  );

  const porLista = (qual: Lista, lista: string[][]) => mudar(qual === 'cols' ? { cols: lista } : qual === 'cons' ? { cons: lista } : { idx: lista });

  const alterar = (qual: Lista, l: number, c: number, valor: Valor) => {
    const linha = [...atual.current[qual][l]];
    linha[c] = texto(valor);
    if (qual === 'cols') colsChanged(linha, c);
    else if (qual === 'idx') idxChanged(linha, c);
    porLista(qual, atual.current[qual].map((r, i) => (i === l ? linha : r)));
  };

  // Linhas só entram e saem pelos botões Incluir/Remover (que pedem confirmação), não pelo Insert/Ctrl+Del.
  const incluir = (qual: Lista, unico = false) => {
    postEdit();
    const linha = qual === 'cols' ? ['', 'int', '', '', '', '', '', '', '', '', ''] : qual === 'idx' ? ['', '', unico ? 'UNIQUE' : 'INDEX'] : ['', '', sFk, '', '', '', ''];
    const lista = [...atual.current[qual], linha];
    porLista(qual, lista);
    // Foco no nome, o primeiro campo vazio (no índice, nas colunas: o nome sai das colunas escolhidas). A linha
    // nova só existe na grade depois de a tela redesenhar; com o foco na célula, é só digitar.
    setTimeout(() => grades[qual].current?.focar(lista.length - 1, qual === 'idx' ? 1 : 0));
  };

  const remover = async (qual: Lista) => {
    postEdit();
    const linha = atual.current[qual][grades[qual].current?.foco()?.linha ?? -1];
    if (!linha) return;
    if (qual === 'cons' && linha[rKind] === sPk) {
      avisar.alerta('A chave primária sai das colunas marcadas como PK na aba Colunas.');
      return;
    }
    const oQue = qual === 'cols' ? 'a coluna' : qual === 'idx' ? 'o índice' : 'a chave estrangeira';
    if (
      !(await confirmar({
        titulo: `Remover ${oQue}?`,
        mensagem: `Remover ${oQue} "${linha[0]}"?\nA alteração só vai para o banco ao clicar em Aplicar alterações.`,
        confirmar: 'Remover',
      }))
    ) {
      return;
    }
    porLista(qual, atual.current[qual].filter((r) => r !== linha));
  };

  // Troca a coluna focada com a de cima (-1) ou a de baixo (1). No Aplicar, a ordem nova vai como MODIFY ... AFTER.
  const mover = (d: number) => {
    postEdit();
    const r = gradeCols.current?.foco()?.linha ?? -1;
    const n = r + d;
    const cols = [...atual.current.cols];
    if (r < 0 || n < 0 || n >= cols.length) return;
    [cols[r], cols[n]] = [cols[n], cols[r]];
    mudar({ cols });
    gradeCols.current?.focar(n);
  };

  // ----------------------------------------------------------
  // Triggers: incluir/editar/excluir pela barra, pelo menu (como o do dbForge) ou com duplo clique.
  // Vão para o banco no Aplicar alterações.
  // ----------------------------------------------------------
  const temTrg = Boolean(estado.trg[trgLinha]);
  const corpoTrg = lf(estado.trg[trgLinha]?.[tBody] ?? '');

  const novaTrigger = () => setDlg({ linha: -1, nome: '', momento: 'BEFORE', evento: 'INSERT', corpo: 'BEGIN\n    \nEND' });

  const editarTrigger = () => {
    const t = atual.current.trg[trgLinha];
    if (t) setDlg({ linha: trgLinha, nome: t[tName], momento: t[tTiming], evento: t[tEvent], corpo: lf(t[tBody]) });
  };

  const gravarTrigger = (t: Trigger) => {
    if (!dlg) return;
    const trg = atual.current.trg;
    if (dlg.linha < 0) {
      mudar({ trg: [...trg, [t.nome, t.momento, t.evento, t.corpo, '', '1']] });
      setTimeout(() => gradeTrg.current?.focar(trg.length));
    } else mudar({ trg: trg.map((r, i) => (i === dlg.linha ? [t.nome, t.momento, t.evento, t.corpo, r[tOrig], '1'] : r)) });
    setDlg(null);
  };

  const excluirTrigger = async () => {
    const t = atual.current.trg[trgLinha];
    if (!t) return;
    if (!(await confirmar({ titulo: 'Excluir a trigger?', mensagem: `Excluir a trigger "${t[tName]}"?\nA alteração só vai para o banco ao clicar em Aplicar alterações.` }))) return;
    const e = atual.current;
    mudar({ trg: e.trg.filter((r) => r !== t), trgDrop: t[tOrig] !== '' ? [...e.trgDrop, t[tOrig]] : e.trgDrop });
  };

  // Atalhos do menu da grade de triggers (a grade é só leitura: essas teclas passam por ela sem uso)
  const teclaTrg = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') editarTrigger();
    else if (e.key === 'Insert') novaTrigger();
    else if (e.key === 'Delete' && e.ctrlKey) void excluirTrigger();
    else return;
    e.preventDefault();
  };

  const itensMenu: ItemMenu[] = [
    { texto: 'Editar trigger', icone: Pencil, onClick: editarTrigger, desabilitado: !temTrg, atalho: 'Enter' },
    { texto: 'Nova trigger', icone: Plus, onClick: novaTrigger, atalho: 'Ins' },
    '-',
    { texto: 'Excluir', icone: Trash2, onClick: () => void excluirTrigger(), perigo: true, desabilitado: !temTrg, atalho: 'Ctrl+Del' },
  ];

  // ----------------------------------------------------------
  // Rodapé
  // ----------------------------------------------------------
  // Padrão BMsoft: tabela com id_app ganha a trigger que gera o id_app no INSERT, se ainda não tiver uma.
  const idAppTrigger = async (s: TableSpec): Promise<string> => {
    if (!s.cols.some((c) => mesmoTexto(c.name, 'id_app'))) return '';
    if (
      !nova &&
      (
        await linhas(
          alvo,
          'SELECT 1 FROM information_schema.triggers WHERE event_object_schema=? ' +
            "AND event_object_table=? AND action_timing='BEFORE' AND event_manipulation='INSERT' " +
            "AND action_statement LIKE '%NEW.id_app%'",
          [banco, tabela],
        )
      ).length > 0
    )
      return '';
    return (
      'DELIMITER $$\n' +
      'CREATE TRIGGER ' + q('trg_' + s.name + '_id_app') + ' BEFORE INSERT ON ' + q(s.name) + ' FOR EACH ROW\n' +
      'BEGIN\n' +
      '    -- Só gera um novo ID se o campo estiver NULL ou vazio\n' +
      "    IF NEW.id_app IS NULL OR NEW.id_app = '' THEN\n" +
      '        SET NEW.id_app = CONCAT(\n' +
      "            LEFT(DATE_FORMAT(NOW(), '%Y%m%d%H%i%s%f'), 17),\n" +
      "            LPAD(FLOOR(RAND() * 99999999), 8, '0')\n" +
      '        );\n' +
      '    END IF;\n' +
      'END$$\n' +
      'DELIMITER ;\n'
    );
  };

  const recarregar = async () => {
    if (!antigo) return;
    postEdit();
    if (mudou(antigo, atual.current) && !(await confirmarDescarte('Descartar as alterações não aplicadas?'))) return;
    setOcupado(true);
    try {
      const old = await carregar(antigo.name);
      if (interna === 'sql') void mostrarSql(old);
    } catch (e) {
      avisar.erro(e);
    } finally {
      setOcupado(false);
    }
  };

  const scriptDasAlteracoes = async () => {
    if (!antigo) return;
    postEdit();
    const s = specDe(atual.current);
    try {
      const sc = designScript(antigo, s, nova) + (await idAppTrigger(s)) + trgScript(atual.current, s.name);
      if (sc === '') setInfo('Nenhuma alteração.');
      else app.abrirConsulta(aba.conexao, banco, sc);
    } catch (e) {
      avisar.erro(e);
    }
  };

  const aplicar = async () => {
    if (!antigo || ocupado) return;
    postEdit();
    const s = specDe(atual.current);
    if (s.name === '') {
      avisar.alerta('Informe o nome da tabela.');
      campoNome.current?.focus();
      return;
    }
    if (s.cols.length === 0) return avisar.alerta('Inclua pelo menos uma coluna.');
    const semTipo = s.cols.find((c) => c.colType === '');
    if (semTipo) return avisar.alerta(`Informe o tipo da coluna "${semTipo.name}".`);
    const renomeou = s.name !== antigo.name; // inclui a tabela nova, que passa a existir
    // A aba Dados relê a tabela quando o nome muda: o que estiver pendente nela se perderia
    if (!nova && renomeou && dados.current?.temAlteracoes()) return avisar.alerta('Salve ou descarte as alterações da aba Dados antes de renomear a tabela.');
    setOcupado(true);
    try {
      const ddl = designScript(antigo, s, nova);
      const trg = (await idAppTrigger(s)) + trgScript(atual.current, s.name);
      const sc = ddl + trg;
      if (sc === '') {
        setInfo('Nenhuma alteração para aplicar.');
        return;
      }
      mostrar('sql');
      pedidoSql.current++; // o CREATE que a aba SQL ainda estiver buscando não vale mais
      setSqlTexto(sc);
      // o DROP TRIGGER das triggers alteradas não perde dados
      const perde = ddl.toUpperCase().includes('DROP ');
      if (
        !(await confirmar({
          titulo: 'Aplicar as alterações?',
          mensagem:
            `Executar no banco "${banco}" o script de alterações mostrado na aba SQL?` +
            (perde ? '\n\nAtenção: o script remove colunas, índices ou chaves. Os dados dessas colunas são perdidos.' : ''),
          confirmar: 'Executar',
          tom: perde ? 'perigo' : 'normal',
        }))
      ) {
        return;
      }
      try {
        await rodar(alvo, splitScript(sc));
      } catch (e) {
        const msg = mensagemDe(e);
        app.log(`Tabela ${banco}.${s.name}: ERRO ${msg}`);
        avisar.erro(msg + '\n\nParte do script pode ter sido aplicada: clique em Atualizar objeto para ver a estrutura atual.');
        return;
      }
      app.log(`Tabela ${banco}.${s.name}: alterações aplicadas.`);
      if (renomeou) {
        app.alterarAba(aba.id, { titulo: `${banco}.${s.name}`, tabela: s.name });
        app.atualizarArvore(aba.conexao, banco, 'tables');
      }
      if (trg !== '') app.atualizarArvore(aba.conexao, banco, 'triggers');
      try {
        const old = await carregar(s.name);
        setInfo('Alterações aplicadas.');
        void mostrarSql(old);
        // A aba Dados relê a estrutura nova, se não tiver nada pendente (renomeada, já relê sozinha pelo nome)
        if (!renomeou && dados.current && !dados.current.temAlteracoes()) void dados.current.recarregar();
      } catch (e) {
        avisar.erro(`As alterações foram aplicadas, mas não consegui reler a tabela: ${mensagemDe(e)}`);
      }
    } catch (e) {
      avisar.erro(e); // falha fora do script (conexão caiu, senha cancelada)
    } finally {
      setOcupado(false);
    }
  };

  // ----------------------------------------------------------
  // Tela
  // ----------------------------------------------------------
  const abas: ItemAba[] = [
    ...(nova ? [] : [{ id: 'dados', titulo: 'Dados', icone: Table }]),
    { id: 'cols', titulo: 'Colunas', icone: Columns3 },
    { id: 'cons', titulo: 'Foreign Keys', icone: KeyRound },
    { id: 'idx', titulo: 'Índices', icone: ListOrdered },
    // ponytail: Opções só mostra; alterar pelo SQL até precisar de edição
    ...(nova ? [] : [{ id: 'opt', titulo: 'Opções', icone: SlidersHorizontal }, { id: 'trg', titulo: 'Triggers', icone: Zap }]),
    { id: 'sql', titulo: 'SQL', icone: FileCode },
  ];
  // As abas internas ficam montadas (escondidas): as grades guardam a linha em foco e as larguras
  const painel = (id: string) => (interna === id ? 'flex-1 min-h-0 flex flex-col' : 'hidden');
  const cx = app.conexao(aba.conexao);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Abas
        abas={abas}
        ativa={interna}
        onTrocar={trocarAba}
        // Como o "servidor | usuário | banco" do dbForge
        direita={<span className="whitespace-pre">{`${cx?.servidor ?? ''}${versao}   |   ${cx?.usuario ?? ''}   |   ${banco}`}</span>}
      />

      {antigo ? (
        <>
          {/* Nome / Banco / Comentário acompanham a aba ativa; Dados e SQL não têm cabeçalho */}
          {interna !== 'dados' && interna !== 'sql' && (
            <div className="shrink-0 flex items-center gap-4 px-2 py-1 border-b border-borda text-xs text-texto2">
              <label className="flex items-center gap-2">
                Nome:
                <input ref={campoNome} value={estado.nome} onChange={(e) => mudar({ nome: e.target.value })} required maxLength={64} className={`${CAMPO} w-60`} />
              </label>
              <label className="flex items-center gap-2">
                Banco:
                <input value={banco} readOnly tabIndex={-1} className={`${CAMPO} w-45 opacity-60`} />
              </label>
              <label className="flex-1 min-w-0 flex items-center gap-2">
                Comentário:
                <input value={estado.comentario} onChange={(e) => mudar({ comentario: e.target.value })} className={`${CAMPO} flex-1 max-w-90`} />
              </label>
            </div>
          )}

          <div className={painel('cols')}>
            <div className={`${BARRA} text-xs text-texto2`}>
              <label className="flex items-center gap-2 pl-1 pr-3">
                Engine:
                <input value={estado.engine} onChange={(e) => mudar({ engine: e.target.value })} list={idEngines} autoComplete="off" className={`${CAMPO} w-40`} />
                <datalist id={idEngines}>
                  {['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE'].map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
              </label>
              <Botao icone={Plus} onClick={() => incluir('cols')}>
                Incluir coluna
              </Botao>
              <Botao icone={Trash2} onClick={() => void remover('cols')}>
                Remover coluna
              </Botao>
              <Botao icone={ArrowUp} onClick={() => mover(-1)}>
                Mover para cima
              </Botao>
              <Botao icone={ArrowDown} onClick={() => mover(1)}>
                Mover para baixo
              </Botao>
            </div>
            <Grade
              ref={gradeCols}
              colunas={colunasCols}
              linhas={estado.cols}
              editavel
              // Decimais só nos tipos que têm.
              podeEditar={(l, c) => c !== cDec || hasDecimals(estado.cols[l]?.[cType] ?? '')}
              onAlterar={(l, c, v) => alterar('cols', l, c, v)}
              vazio="Nenhuma coluna"
            />
          </div>

          <div className={painel('cons')}>
            <div className={BARRA}>
              <Botao icone={KeyRound} onClick={() => incluir('cons')}>
                Incluir chave estrangeira
              </Botao>
              <Botao icone={Trash2} onClick={() => void remover('cons')}>
                Remover
              </Botao>
            </div>
            <Grade
              ref={gradeCons}
              colunas={colunasCons}
              linhas={estado.cons}
              editavel
              // A linha da PK e o tipo da restrição não se editam (a PK sai das colunas marcadas na aba Colunas).
              podeEditar={(l) => estado.cons[l]?.[rKind] !== sPk}
              onAlterar={(l, c, v) => alterar('cons', l, c, v)}
              onFoco={(l) => setConsLinha(l)}
              vazio="Nenhuma chave"
            />
          </div>

          <div className={painel('idx')}>
            <div className={BARRA}>
              <Botao icone={Plus} onClick={() => incluir('idx')}>
                Incluir índice
              </Botao>
              <Botao icone={KeyRound} onClick={() => incluir('idx', true)}>
                Incluir índice único
              </Botao>
              <Botao icone={Trash2} onClick={() => void remover('idx')}>
                Remover índice
              </Botao>
            </div>
            <Grade ref={gradeIdx} colunas={colunasIdx} linhas={estado.idx} editavel onAlterar={(l, c, v) => alterar('idx', l, c, v)} vazio="Nenhum índice" />
          </div>

          {!nova && (
            <div className={painel('opt')}>
              <Grade colunas={COLS_OPCOES} linhas={opcoes} />
            </div>
          )}

          {/* Triggers: a lista em cima e o comando da escolhida embaixo */}
          {!nova && (
            <div className={painel('trg')}>
              <div className={BARRA}>
                <Botao icone={Plus} onClick={novaTrigger}>
                  Nova trigger
                </Botao>
                <Botao icone={Pencil} onClick={editarTrigger}>
                  Editar trigger
                </Botao>
                <Botao icone={Trash2} onClick={() => void excluirTrigger()}>
                  Excluir trigger
                </Botao>
              </div>
              <div className="flex-1 min-h-0 flex flex-col" onKeyDown={teclaTrg}>
                <Grade
                  ref={gradeTrg}
                  colunas={COLS_TRG}
                  linhas={estado.trg}
                  onFoco={(l) => setTrgLinha(l)}
                  onDuploClique={editarTrigger}
                  onMenu={(e) => setMenu({ x: e.clientX, y: e.clientY })}
                  vazio="Nenhuma trigger"
                />
              </div>
              <Divisor aoArrastar={arrastarTrg} />
              <div style={{ height: alturaTrg }} className="shrink-0 min-h-0 flex flex-col">
                {/* Só para ler: o editor é refeito quando a trigger em foco (ou o comando dela) muda */}
                {interna === 'trg' && <EditorSql key={corpoTrg} inicial={corpoTrg} somenteLeitura className="flex-1" />}
              </div>
            </div>
          )}

          {/* Só para ler: o editor é refeito quando o texto muda */}
          {interna === 'sql' && <EditorSql key={sqlTexto} inicial={sqlTexto} somenteLeitura className="flex-1" />}
        </>
      ) : (
        interna !== 'dados' &&
        (falhou ? (
          <div className="flex-1 flex items-center justify-center">
            <Botao icone={RefreshCw} onClick={() => void abrir()}>
              Tentar de novo
            </Botao>
          </div>
        ) : (
          <Carregando />
        ))
      )}

      {/* Dados: abre a consulta junto com a estrutura, sem esperar por ela */}
      {!nova && abriuDados && (
        <div className={painel('dados')}>
          <GradeDados ref={dados} alvo={alvo} banco={banco} tabela={tabela} comAtalhos />
        </div>
      )}

      {/* Rodapé, como o do dbForge, com o resumo / avisos à direita; Dados não tem rodapé */}
      {antigo && interna !== 'dados' && (
        <div className="shrink-0 flex items-center gap-1 px-1 py-1 bg-fundo2 border-t border-borda">
          <Botao icone={RefreshCw} onClick={() => void recarregar()} disabled={ocupado}>
            Atualizar objeto
          </Botao>
          <Botao icone={Check} onClick={() => void aplicar()} ocupado={ocupado}>
            Aplicar alterações
          </Botao>
          <Botao icone={FileCode} onClick={() => void scriptDasAlteracoes()} disabled={ocupado}>
            Script das alterações
          </Botao>
          <span className="ml-auto pr-3 min-w-0 truncate text-xs text-texto2">{info}</span>
        </div>
      )}

      {menu && <MenuContexto x={menu.x} y={menu.y} itens={itensMenu} onFechar={() => setMenu(null)} />}
      {dlg && (
        <DialogoTrigger titulo={dlg.linha < 0 ? 'Nova trigger' : 'Editar trigger'} tabela={estado.nome.trim()} inicial={dlg} onOk={gravarTrigger} onFechar={() => setDlg(null)} />
      )}
    </div>
  );
};
